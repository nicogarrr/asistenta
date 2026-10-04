import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { BrowserService } from '../browser/service.js';
import {
  describePassengerCompleteness,
  fillPassengerForm,
  loadPassenger,
  type Passenger,
  type PassengerSelectors,
} from '../commerce/profile.js';
import { log, redact } from '../log.js';
import type { PurchaseStage, ToolCall } from '../permissions.js';
import { buildFillScript } from './browser.js';

/**
 * Buying something, up to the click the agent is not allowed to make.
 *
 * The failure this tool exists to fix is not "the agent cannot buy", it is "the agent
 * stops in the middle and says it could not continue". A purchase is thirty ordinary
 * actions - open, type, click, next - and every one of them used to be a question or a
 * gate refusal, so the run died at step one having bought nothing and having no reason
 * the model could act on. Here the flow is explicit: browse, fill, and stop. Only the
 * last step asks, and it asks with the price in the sentence.
 *
 * Three rules shaped the whole file, and each one is a place where the obvious
 * implementation is wrong:
 *
 * 1. **The charge is never automated.** Not "ask first and then click", not "click
 *    unless the card looks unusual". There is no code path here that presses a payment
 *    button: `confirm` takes no selector, so there is nothing to point one at, and
 *    `select` reads the button's label before clicking and refuses anything that reads
 *    like a charge. `confirm` hands the browser to the human and stops. Two reasons, and
 *    the second is the one that is not negotiable: a mistake here costs a fee and a
 *    refund that means telephoning a bank, and accepting a contract on someone's behalf
 *    is an act that has to be theirs.
 * 2. **The model never sees the buyer's details.** It gets "the data is complete" or
 *    "the document is missing". The values travel vault -> DOM inside
 *    `fillPassengerForm` and stop there. See `commerce/profile.ts`.
 * 3. **The stage is declared, not inferred.** `CHECKOUT_STAGES` maps each action to a
 *    `PurchaseStage` and the daemon hands that map to the gate, so "this call is a
 *    browse step" is a fact in one table rather than a guess the gate makes from the
 *    arguments of a page it cannot see.
 */

/** What this tool can drive. Deliberately small: five verbs, no "do anything". */
export type CheckoutAction = 'search' | 'select' | 'fill_passenger' | 'status' | 'confirm';

/**
 * Every action, and the purchase stage it belongs to.
 *
 * The one table that decides how the gate treats a call. `browse` and `fill` run
 * unattended; `confirm` is the only step the human is asked about, and only because it
 * carries the amount. Read as a whole it is the policy, in five rows.
 */
export const CHECKOUT_STAGES: Record<CheckoutAction, PurchaseStage> = {
  search: 'browse',
  select: 'browse',
  fill_passenger: 'fill',
  // Reading where the flow is. `browse` rather than a stage of its own so the answer
  // to "can I check on this?" is never "no".
  status: 'browse',
  confirm: 'confirm',
};

const STAGE_RANK: Record<PurchaseStage, number> = { browse: 0, fill: 1, confirm: 2 };

/**
 * The stage of a call, for the gate's `stageOf` resolver.
 *
 * Unknown tool, unknown action: `undefined`. The gate then falls back to its ordinary
 * rules, which ask, so a new action added to this file without a row here fails towards
 * a question rather than towards silence.
 */
export function checkoutStageOf(call: Pick<ToolCall, 'tool' | 'args'>): PurchaseStage | undefined {
  if (call.tool !== 'checkout') return undefined;
  const action = typeof call.args.action === 'string' ? call.args.action : '';
  return CHECKOUT_STAGES[action as CheckoutAction];
}

/**
 * Labels that submit a charge.
 *
 * Narrow in one direction and broad in the other, deliberately. `pago` alone is not
 * matched, because "Continuar al pago" and "Ir al paso de pago" are exactly the buttons
 * the agent must be allowed to press to reach the payment screen; `pagar` and `abonar`
 * are, because those verbs are the charge. Refusing a harmless button costs one tool
 * call and a question to the user; missing a charge costs a fee and a phone call to a
 * bank, so every ambiguity resolves towards refusal.
 */
const PAYMENT_LABEL =
  /\b(pagar|abonar|cobrar|charge|paying|checkout\s+now|complete\s+(payment|purchase|order)|confirmar?\s+(el\s+)?pago|confirmar?\s+pedido|realizar\s+(el\s+)?pago|pagar\s+(el\s+)?pedido|finalizar\s+(la\s+)?compra|place\s+order|pay\s+now|buy\s+now|submit\s+(payment|order))\b/i;

/**
 * Whether a button's label means "charge the card".
 *
 * Exported because this is the property the whole design rests on, and a property
 * nobody can assert is a comment.
 */
export function looksLikePaymentSubmission(label: string): boolean {
  return PAYMENT_LABEL.test(label);
}

/** Prices visible in a block of page text, normalised, deduplicated, in order. */
export function extractPrices(text: string, limit = 5): string[] {
  const re =
    /(\d{1,3}(?:[.\u00a0 ]\d{3})*(?:,\d{2})?)\s*(?:€|EUR|\$|£)|(?:€|EUR|\$|£)\s*(\d{1,3}(?:[.\u00a0 ]\d{3})*(?:,\d{2})?)/gi;
  const out: string[] = [];
  for (const match of text.matchAll(re)) {
    const raw = (match[1] ?? match[2] ?? '').replace(/[\u00a0 ]/g, '');
    if (!raw) continue;
    if (out.includes(raw)) continue;
    out.push(raw);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The page this tool drives.
 *
 * An interface of five operations rather than a Playwright handle, because every
 * interesting property of this tool is testable only if the page is a fake: "confirm
 * clicked nothing" and "fill_passenger printed no document" are the two tests that
 * matter, and neither can be written against a real browser.
 */
export interface CheckoutPage {
  open(url: string): Promise<{ url: string; title: string }>;
  /** Accessible name of an element, read without touching it. */
  label(selector: string): Promise<string>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  /** A key on an element, e.g. Enter to submit a search box that has no button. */
  press(selector: string, key: string): Promise<void>;
  text(): Promise<string>;
  url(): Promise<string>;
  /** Put the window on screen so the human can finish. False when there is nothing to show. */
  show(): Promise<boolean>;
}

function q(value: string): string {
  return JSON.stringify(value);
}

/**
 * The real page: Playwright through the daemon's browser, so it is the same profile, the
 * same session and the same domain approvals as the `browser` tool. No second browser.
 *
 * `fill` never returns what it wrote. `buildFillScript` reports the field's final value
 * on a mismatch, which is the right thing for a search box and exactly the wrong thing
 * for a DNI, so the value is discarded here and the error is rebuilt without it.
 */
export function createCheckoutPage(service: BrowserService, scope: () => string): CheckoutPage {
  const run = async (code: string, visible?: boolean): Promise<string> => {
    const result = await service.execJs(
      scope(),
      code,
      visible === undefined ? undefined : { visible },
    );
    // execJs returns a thrown error as text so the model can read it verbatim; here it
    // is an exception, because the tool decides what the model hears about a failure.
    if (result.text.startsWith('error: ')) throw new Error(result.text.slice(7));
    return result.text;
  };

  return {
    async open(url: string) {
      return service.open(scope(), url);
    },

    async label(selector: string) {
      return run(`const loc = page.locator(${q(selector)}).first();
if ((await loc.count()) === 0) return '';
const name = await loc
  .evaluate((el) =>
    String(
      el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('name') ||
        el.textContent ||
        '',
    ).trim().slice(0, 160))
  .catch(() => '');
return name;`);
    },

    async fill(selector: string, value: string) {
      const report = await run(buildFillScript(selector, value));
      // buildFillScript's own message embeds what is in the field. For a passenger form
      // that value may be a DNI, so the value is dropped and only the selector, which
      // the caller supplied, is named.
      if (report.startsWith('ATENCIÓN')) {
        throw new Error(
          `el campo ${selector} no aceptó el valor; revisa si la web lo autocompleta o lo bloquea`,
        );
      }
    },

    async click(selector: string) {
      await run(`await page.locator(${q(selector)}).first().click();
return 'clicked';`);
    },

    async press(selector: string, key: string) {
      await run(`await page.locator(${q(selector)}).first().press(${q(key)});
return 'pressed';`);
    },

    async text() {
      return run('return (await page.locator("body").innerText()).slice(0, 8000);');
    },

    async url() {
      return run('return page.url();');
    },

    async show() {
      const before = await run('return page.url();');
      if (!/^https?:/i.test(before)) return false;
      // Promoting to a visible window relaunches the context, which loses the page. So
      // the URL is captured first and restored only if the promotion actually navigated
      // away; otherwise the checkout page would be reloaded and the form lost.
      await run('return page.title();', true);
      const after = await run('return page.url();');
      if (after !== before) await service.open(scope(), before);
      return true;
    },
  };
}

/** Where one purchase has got to. Held per tool instance, i.e. per conversation. */
export interface CheckoutFlow {
  stage: PurchaseStage;
  /** What is being bought, as the model described it. Not a payment word: see the tool. */
  item: string | null;
  /** The price the page showed, kept so `confirm` can say it without re-reading. */
  price: string | null;
  /** Where the flow is, for the log and the audit trail. Never a full URL with a token. */
  url: string | null;
  /** Set only by an approved `confirm`. Never by the model. */
  approved: { item: string; amount: string; at: string } | null;
}

function freshFlow(): CheckoutFlow {
  return { stage: 'browse', item: null, price: null, url: null, approved: null };
}

export interface CheckoutToolDeps {
  page: CheckoutPage;
  /**
   * Buyer's details from the vault. Injected so the tests exercise the empty-vault path
   * without creating a real one, and so the values can be asserted to never appear in a
   * tool result.
   */
  loadPassenger?: () => Promise<Passenger | null>;
  /**
   * Human confirmation. Called before anything that spends money, with a sentence that
   * names the purchase and the amount. Same contract as the mail tool: the gate asks
   * too, and the tool asks again, because a gate that can be misconfigured is not a
   * reason to leave the charge to chance.
   */
  requireApproval: (action: string, summary: string) => Promise<boolean>;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const CheckoutParams = Type.Object({
  action: Type.Union([
    Type.Literal('search'),
    Type.Literal('select'),
    Type.Literal('fill_passenger'),
    Type.Literal('status'),
    Type.Literal('confirm'),
  ]),
  url: Type.Optional(
    Type.String({ description: 'Para search: la pagina donde empieza la compra.' }),
  ),
  query: Type.Optional(
    Type.String({ description: 'Para search: que buscar (destino, producto, fecha...).' }),
  ),
  selector: Type.Optional(
    Type.String({
      description:
        'CSS o texto del elemento, del action=snapshot del navegador. Para search: el ' +
        'campo donde escribir la búsqueda. Para select: el elemento que quieres pulsar.',
    }),
  ),
  item: Type.Optional(
    Type.String({
      description:
        'Para select y confirm: qué es lo que se compra, en palabras. Describe el ' +
        'producto (tren, entrada, vuelo), no el pago.',
    }),
  ),
  selectors: Type.Optional(
    Type.Object({
      fullName: Type.Optional(Type.String({ description: 'Selector del campo de nombre.' })),
      document: Type.Optional(Type.String({ description: 'Selector del campo de documento.' })),
      email: Type.Optional(Type.String({ description: 'Selector del campo de email.' })),
      phone: Type.Optional(Type.String({ description: 'Selector del campo de telefono.' })),
    }),
  ),
  price: Type.Optional(
    Type.String({
      description:
        'Para confirm: el importe que has leido en la pagina. Se contrasta con lo que ' +
        'la pagina muestra ahora.',
    }),
  ),
});

export function createCheckoutTool(deps: CheckoutToolDeps): AgentTool<typeof CheckoutParams> {
  const load = deps.loadPassenger ?? (() => loadPassenger());
  const { page } = deps;
  let flow = freshFlow();

  /**
   * Never press a charge.
   *
   * The label is read before the click, not after, so there is no window in which the
   * click has already happened. A button that reads as a charge is refused with a
   * message the model can act on: the human presses it.
   */
  const refuseIfCharge = async (selector: string): Promise<void> => {
    const label = await page.label(selector).catch(() => '');
    if (!looksLikePaymentSubmission(label)) return;
    throw new Error(
      `no pulso "${label}": ese botón cobra el dinero y el pago lo hace la persona, no yo. ` +
        'Dile al usuario que está todo listo y que pulse él.',
    );
  };

  const advance = (stage: PurchaseStage): void => {
    if (STAGE_RANK[stage] > STAGE_RANK[flow.stage]) flow.stage = stage;
  };

  const describeState = (): string => {
    const lines = [`Etapa: ${flow.stage}.`];
    lines.push(flow.item ? `Producto: ${flow.item}.` : 'Producto: todavia no elegido.');
    lines.push(
      flow.price
        ? `Importe visto en la pagina: ${flow.price}.`
        : 'Importe: todavia no leido de la pagina.',
    );
    lines.push(
      flow.approved
        ? `Compra confirmada por el usuario (${flow.approved.amount}, ${flow.approved.at}). ` +
            'Falta el pago, y ese lo hace el usuario.'
        : 'Compra sin confirmar todavia.',
    );
    return lines.join(' ');
  };

  return {
    name: 'checkout',
    label: 'Compra',
    description: [
      'Compras de principio a fin, sin molestar al usuario hasta el ultimo momento.',
      '',
      'Como trabajar:',
      '1. action=search para abrir la pagina (url) y buscar lo que te han pedido (query,',
      '   en el campo selector).',
      '2. action=select para elegir el producto concreto: selector del elemento y item con',
      '   lo que es. Repite hasta que la pantalla sea la de datos del comprador.',
      '3. action=fill_passenger con los selectores de los campos (sacalos de un',
      '   action=snapshot del navegador). Los valores salen del vault: no los pido, no los veo',
      '   y no tengo que escribirlos yo.',
      '4. action=status para saber en que punto estas.',
      '5. action=confirm cuando la pantalla muestre el importe. Ahi se para todo y se le',
      '   pregunta al usuario que dice y cuanto cuesta.',
      '',
      'Puedes navegar, buscar, elegir y rellenar sin preguntar NADA. No digas que necesitas',
      'aprobacion para abrir una web ni para buscar. La unica pregunta es la del pago.',
      '',
      'LO QUE NO HAGO, Y NO SE PUEDE HACER CONTRA MI:',
      '- No pulso el boton de pagar. Nunca. Ni aunque el usuario lo pida en el chat. El',
      '  boton de cobrar es suyo: un error al pagar cuesta comision y la devolucion exige',
      '  llamar por telefono, y aceptar las condiciones de una compra es un acto suyo.',
      '  Si el selector que te han dado parece un boton de pago, action=select lo rechaza.',
      '- No escribo ni leo tarjetas, ni claves, ni CVV, ni leo ficheros con tus datos.',
      '  action=fill_passenger es la unica via para poner tus datos en un formulario.',
      '- No veo tus datos personales. Solo se si estan completos o que falta.',
      '',
      'En action=confirm solo se admiten item y price: no admite selector, porque no toca',
      'ningun boton. Cuando el usuario confirme, teLimits a decirle que ya esta todo listo y',
      'que pulse el. Si el devuelve "si" y vuelve a llamar a confirm, se le vuelve a pedir.',
    ].join('\n'),
    parameters: CheckoutParams,
    // Sequential: one page, and two selections clicking at once is how the wrong option
    // gets bought.
    executionMode: 'sequential',
    execute: async (_id, raw) => {
      const args = raw as unknown as Record<string, unknown>;
      const action = textOf(args.action);

      switch (action) {
        case 'search': {
          const url = textOf(args.url);
          const query = textOf(args.query);
          if (!url && !query) throw new Error('search necesita url o query');
          // A new URL is a new purchase, so the previous one's confirmation goes with
          // it: an approval for one amount is never an approval for another.
          if (url) flow = freshFlow();

          let title = '';
          if (url) {
            const info = await page.open(url);
            flow.url = info.url;
            title = info.title;
          }
          if (query) {
            const selector = textOf(args.selector);
            if (!selector) throw new Error('search con query necesita el selector del campo');
            // The guard runs here too, not only on `select`: pressing Enter inside a box
            // on a payment page can submit the form, and "which button does this key
            // press" is not something this tool can know from the selector alone.
            await refuseIfCharge(selector);
            await page.fill(selector, query);
            await page.press(selector, 'Enter');
          }
          advance('browse');

          const prices = extractPrices(await page.text().catch(() => ''));
          if (prices[0]) flow.price = prices[0];
          log.info('checkout search', redact({ host: url ? hostOfUrl(url) : null, prices }));
          return {
            content: [
              {
                type: 'text',
                text:
                  `Abierto: ${await page.url()}${title ? ` (${title})` : ''}` +
                  `${query ? ` · buscado: ${query}` : ''}\n` +
                  `Precios en la pagina: ${prices.length ? prices.join(', ') : 'ninguno visible'}.`,
              },
            ],
            details: { stage: flow.stage, prices, hasItem: flow.item !== null },
          };
        }

        case 'select': {
          const selector = textOf(args.selector);
          if (!selector) throw new Error('select necesita selector');
          await refuseIfCharge(selector);
          await page.click(selector);
          const item = textOf(args.item);
          if (item) flow.item = item;
          const prices = extractPrices(await page.text().catch(() => ''));
          if (prices[0]) flow.price = prices[0];
          advance('browse');
          log.info('checkout select', { stage: flow.stage, hasItem: flow.item !== null });
          return {
            content: [
              {
                type: 'text',
                text:
                  `Pulsado ${selector}. ${describeState()} ` +
                  'Sigue hasta la pantalla de datos del comprador.',
              },
            ],
            details: { stage: flow.stage, hasItem: flow.item !== null, prices },
          };
        }

        case 'fill_passenger': {
          const selectors = (args.selectors ?? {}) as PassengerSelectors;
          const passenger = await load();
          if (!passenger) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    'No tengo ningun dato de comprador guardado, asi que no puedo rellenar el ' +
                    'formulario. Pídele al usuario el nombre completo, el documento, el email y ' +
                    'el teléfono UNA vez, en un solo mensaje, y ofrécele guardarlos: se guardan ' +
                    'en el vault y no vuelve a hacer falta. Dile los comandos exactos ' +
                    '(`pa vault set travel:fullName "..."` y assim) para que no tengas que ' +
                    'escribir sus datos ni verlos tu.',
                },
              ],
              details: { filled: false, reason: 'sin datos en el vault' },
            };
          }

          const result = await fillPassengerForm(page, passenger, selectors);
          advance('fill');
          // The report is field names and counts. The values are in the page and stayed
          // there: no amount of formatting downstream can put a DNI in the transcript
          // when the string being formatted does not contain one.
          const lines = [
            `Rellenados ${result.filled.length} campo(s): ${result.filled.join(', ') || 'ninguno'}.`,
            'Los valores los he sacado del vault; no te los enseño y no los tengo en contexto.',
          ];
          if (result.unmatched.length) {
            lines.push(
              `Sin campo en el formulario: ${result.unmatched.join(', ')}. ${describePassengerCompleteness(passenger)}`,
            );
          }
          if (result.failed.length) {
            lines.push(
              `No han entrado: ${result.failed.map((f) => `${f.field} (${f.reason})`).join(', ')}.`,
            );
          }
          return {
            content: [{ type: 'text', text: lines.join(' ') }],
            details: {
              filled: result.filled,
              unmatched: result.unmatched,
              failed: result.failed.map((f) => f.field),
              stage: flow.stage,
            },
          };
        }

        case 'status': {
          const completeness = describePassengerCompleteness(await load());
          return {
            content: [{ type: 'text', text: `${describeState()} ${completeness}` }],
            details: { ...flow, stage: flow.stage },
          };
        }

        case 'confirm': {
          // Structural guarantee, not a policy statement: `confirm` has no selector, so
          // there is no argument through which a pay button could be named. Anything
          // passed here is refused rather than ignored, because a silently dropped
          // argument is how a caller concludes it did something.
          if (textOf(args.selector)) {
            throw new Error(
              'confirm no acepta selector: esta accion no toca ningun boton de la pagina. ' +
                'Pagar lo hace el usuario.',
            );
          }

          const visible = await page.text().catch(() => '');
          const prices = extractPrices(visible);
          const item = textOf(args.item) || flow.item;
          const declared = textOf(args.price);
          const fromPage = prices[0] ?? null;
          const amount = declared || flow.price || fromPage;

          if (!amount) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    'No he encontrado ningun importe en la pagina, asi que no te pido que ' +
                    'confirmes una compra cuyo precio no conozco. Mira el total con el ' +
                    'navegador y vuelve a llamar a confirm con price.',
                },
              ],
              details: { asked: false, reason: 'sin importe visible' },
            };
          }
          if (!item) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    'No se que producto es este antes de pedirte que lo confirmes. Llama antes ' +
                    'a select con item, o pásamelo en item.',
                },
              ],
              details: { asked: false, reason: 'sin producto' },
            };
          }

          const mismatch =
            declared && fromPage && declared !== fromPage
              ? ` Ojo: tu lees ${declared} y la pagina muestra ${fromPage}.`
              : '';
          const summary = [
            `Voy a comprar: ${item}.`,
            `Importe: ${amount} €.${mismatch}`,
            `Vas a pagar ${amount} € y a aceptar las condiciones de esta web.`,
            'Yo NO pulso el boton de pagar: eso lo haces tu. Dime "si" y te dejo el navegador con la pantalla de pago abierta.',
          ].join(' ');

          const approved = await deps.requireApproval('checkout:confirm', summary);
          if (!approved) {
            log.info('checkout declined', { amount, hasItem: true });
            return {
              content: [
                {
                  type: 'text',
                  text:
                    'No he comprado nada: no lo has confirmado. Dile al usuario que puede ' +
                    'cancelar, o que me diga si lo deja otra vez.',
                },
              ],
              details: { asked: true, approved: false, amount },
            };
          }

          flow.stage = 'confirm';
          flow.approved = { item, amount, at: new Date().toISOString() };
          const shown = await page.show().catch(() => false);
          log.info('checkout confirmed', { amount, shown });
          return {
            content: [
              {
                type: 'text',
                text:
                  `Confirmado: ${item}, ${amount} €. NO he pulsado ningun boton de pago ni ` +
                  'he escrito ninguna tarjeta: no puedo, y esa parte es tuya.' +
                  (shown
                    ? ' Te he dejado el navegador en pantalla con la pantalla de pago: pulsa tu el boton.'
                    : ' Abre la pagina y pulsa tu el boton de pago.') +
                  ' Si quieres que el agente lo haga, no puede: por diseno.',
              },
            ],
            details: { asked: true, approved: true, amount, stage: flow.stage, handedOver: shown },
          };
        }

        default:
          throw new Error(`accion desconocida: ${action || '(vacia)'}`);
      }
    },
  };
}

function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
