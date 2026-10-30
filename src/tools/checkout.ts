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
import { fold, isPaymentText, pageSaysMoney } from '../permissions.js';
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
  /\b(pagar|abonar|cobrar|charge|paying|checkout\s+now|complete\s+(payment|purchase|order)|confirmar?\s+(el\s+)?pago|confirmar?\s+pedido|realizar\s+(el\s+)?pago|pagar\s+(el\s+)?pedido|finalizar\s+(la\s+)?compra|place\s+order|pay\s+now|buy\s+now|submit\s+(payment|order)|book\s+now|reserve\s+now|complete\s+(booking|reservation)|confirm\s+(booking|reservation)|donate|adquirir|^\s*order\s*$|^\s*submit)\b/i;

/**
 * Buttons that lead to the payment screen without paying. Removed from a label before
 * it is tested, so the shared money vocabulary does not refuse the one step the agent
 * has to take to get the human to the payment screen.
 */
const PRE_PAYMENT_NAV =
  /\b(continuar\s+al\s+pago|ir\s+al\s+paso\s+de\s+pago|pasar\s+al\s+pago)\b/gi;

/**
 * Whether a button's label means "charge the card".
 *
 * One vocabulary: the gate's own money words (Spanish and English, folded), plus the
 * narrower charge phrases above. A second, weaker list here is how "Comprar" and "Order
 * now" got through while the gate asked about them everywhere else.
 *
 * Exported because this is the property the whole design rests on, and a property
 * nobody can assert is a comment.
 */
export function looksLikePaymentSubmission(label: string): boolean {
  const cleaned = label.replace(PRE_PAYMENT_NAV, ' ');
  return (
    PAYMENT_LABEL.test(cleaned) || isPaymentText(cleaned) || CONFIRM_BUTTON.test(fold(cleaned))
  );
}

/**
 * "Confirmar" / "Confirm" on a button inside a purchase flow is the last click before the
 * charge on most shops, so it counts as one here (the gate only sees it through the page).
 */
const CONFIRM_BUTTON =
  /(?<![\p{L}\p{N}])(confirmar|confirmo|confirm|confirmacion)(?![\p{L}\p{N}])/u;

/**
 * What a payment screen says in its body when the URL and title say nothing: card fields,
 * payment method, order summary. Specific phrases, not single words, so an ordinary shop
 * page that mentions "comprar" does not lock the buttons.
 */
const PAGE_TEXT_PAYMENT =
  /(?<![\p{L}\p{N}])(numero de (la )?tarjeta|datos de (la )?tarjeta|metodo de pago|forma de pago|resumen del pedido|total a pagar|importe a pagar|payment method|card number|order summary|billing address)(?![\p{L}\p{N}])/u;

/** A price as the page shows it: the number, the currency symbol and both together. */
export interface PriceText {
  raw: string;
  symbol: string;
  text: string;
}

/**
 * The strict price pattern, flagless on purpose so both the global extractor and
 * the anchored label matcher derive their own flags from `.source`.
 *
 * Boundaries are what make a truncated amount impossible: no digits or
 * separators before, and after the amount neither a digit, a comma, nor a dot
 * that continues the number - so "1000€" is not "000", "450.00 EUR" is not
 * "00" and "€29.99" is not "29" (a dot followed by a digit is another decimal,
 * a format this parser refuses to guess). A sentence-ending dot passes: it is
 * not followed by a digit. Thousands groups are exactly 3 digits and decimals
 * exactly 2 with comma; anything malformed matches NOTHING, and no price means
 * no confirm (fail-closed).
 */
const PRICE_RE =
  /(?<![\d.,\u00a0])((?:\d{1,3}(?:[.\u00a0 ]\d{3})+|\d+)(?:,\d{2})?)(?![\d,]|\.(?=\d))\s*(€|EUR|\$|£)(?![A-Za-z])|(€|EUR|\$|£)\s*(?<![\d.,\u00a0])((?:\d{1,3}(?:[.\u00a0 ]\d{3})+|\d+)(?:,\d{2})?)(?![\d,]|\.(?=\d))/;

function toPriceText(match: RegExpMatchArray): PriceText | null {
  const raw = (match[1] ?? match[4] ?? '').replace(/[\u00a0 ]/g, '');
  if (!raw) return null;
  const symbol =
    (match[2] ?? match[3] ?? '').toUpperCase() === 'EUR' ? '€' : (match[2] ?? match[3] ?? '');
  return { raw, symbol, text: `${raw} ${symbol}` };
}

/** Prices visible in a block of page text with their own currency symbol, deduplicated. */
export function extractPriceTexts(text: string, limit = 5): PriceText[] {
  // Strict boundaries: an amount must not be preceded or followed by digits or
  // separators, or "1000€" yields '000' and "450.00 EUR" yields '00' - and a
  // truncated total is a bypass of the cap. Thousands groups are exactly 3
  // digits and decimals exactly 2 with comma; anything malformed matches
  // NOTHING, and no price means no confirm (fail-closed).
  const out: PriceText[] = [];
  for (const match of text.matchAll(new RegExp(PRICE_RE.source, 'gi'))) {
    const price = toPriceText(match);
    if (!price) continue;
    if (out.some((p) => p.raw === price.raw && p.symbol === price.symbol)) continue;
    out.push(price);
    if (out.length >= limit) break;
  }
  return out;
}

/** A page price raw ("1.234,56", "45,20", "300") as cents, or null if it does not parse. */
export function parsePriceToCents(raw: string): number | null {
  const cleaned = raw.replace(/[.\u00a0 ]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number.parseFloat(cleaned) * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * A total only counts when the page labels it - "total", "total a pagar",
 * "importe a pagar", "amount due", "grand total" - and the amount sits RIGHT
 * after the label, separated by nothing but spacing and `:`/`=`/`-`. There is
 * deliberately no window spanning words or sentences: "Total: ver condiciones.
 * Entrega 9,99 €" must not quote the delivery fee as the total.
 */
const TOTAL_LABEL =
  /(?:\btotal(?:\s+a\s+pagar)?\b|\bimporte\s+a\s+pagar\b|\bamount\s+due\b|\bgrand\s+total\b)\s*[:=-]?\s*/iu;

/** Words right before a "total" label that make it the total of something else. */
const NOT_THE_PURCHASE_TOTAL =
  /(?<![\p{L}\p{N}])(descuentos?|ahorros?|ahorras|ahorrado|ahorro|rebaja|cupon|iva|impuestos?|envio|gastos de envio|discounts?|savings|saved|tax|taxes|vat|shipping)\s*$/u;

function matchPriceAt(text: string, at: number): PriceText | null {
  const re = new RegExp(PRICE_RE.source, 'yi');
  re.lastIndex = at;
  const match = re.exec(text);
  return match ? toPriceText(match) : null;
}

/**
 * The one price a confirm may quote: an explicit, readable total. No label, no
 * total - a single visible price is NOT assumed to be it ("29,99 € al mes, 24
 * meses" is not a 29,99 purchase). A label whose amount does not parse strictly
 * ("Total 950.00 EUR") is not skipped in favour of other prices on the page:
 * the total exists and could not be read, which is exactly the case that must
 * deny. Two labels quoting different amounts are as good as no label.
 */
export function findTotalPrice(text: string): PriceText | null {
  let found: PriceText | null = null;
  for (const m of text.matchAll(new RegExp(TOTAL_LABEL.source, 'giu'))) {
    // "Descuento total: 5,00 €", "Ahorro total", "IVA total", "Envío total": a total of
    // something that is not the purchase. If that is the only label on the page, the
    // discount was quoted as the amount and passed the cap. Any such label denies.
    if (NOT_THE_PURCHASE_TOTAL.test(fold(text.slice(Math.max(0, m.index - 30), m.index)))) {
      return null;
    }
    const price = matchPriceAt(text, m.index + m[0].length);
    if (!price) return null;
    if (found && (found.raw !== price.raw || found.symbol !== price.symbol)) return null;
    found = price;
  }
  return found;
}

/**
 * A recurrence or financing hint ANYWHERE on the page. Conservative on
 * purpose: instalment wording before or after the total, in any sentence, no
 * distance limit - "29,99/mes", "Mensual", "Suscripcion", "anual", "24
 * meses" all count. False positives ("garantia 24 meses") go to manual review
 * too: approving a real instalment as a capped one-shot purchase is the
 * expensive direction, and telling them apart for sure would take structured
 * order-summary context, not phrasing rules.
 */
const RECURRENCE =
  /\b(?:al\s+mes|por\s+mes|cada\s+mes|mensual(?:idad|idades)?|mensualmente|semanal(?:mente)?|anual(?:idad|mente)?|cuotas?|plazos?|suscripci\w*|recurrent\w*|monthly|weekly|annual|yearly|installments?|financia\w*|durante\s+\d+\s+meses|\d+\s+meses)\b|\/\s*(?:mes|meses|month|semana|week|a[ñn]o|year)\b/iu;

/**
 * The first recurrence/financing hint on the page, or null when nothing reads
 * as recurring. Any hint refuses the confirm for manual review: the cap never
 * applies to what could be a partial instalment.
 */
export function recurrenceHintInPage(text: string): string | null {
  const hit = text.match(RECURRENCE);
  return hit ? hit[0] : null;
} /** Prices visible in a block of page text, normalised, deduplicated, in order. */
export function extractPrices(text: string, limit = 5): string[] {
  const out: string[] = [];
  for (const price of extractPriceTexts(text, limit * 2)) {
    if (out.includes(price.raw)) continue;
    out.push(price.raw);
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
export interface ElementInfo {
  label: string;
  button: boolean;
  /** Labels of the submit buttons of the element's form; what Enter in a field would press. */
  formSubmit: string;
  /** Page URL and title. */
  where: string;
}

export interface CheckoutPage {
  open(url: string): Promise<{ url: string; title: string }>;
  /** Accessible name of an element, read without touching it. */
  label(selector: string): Promise<string>;
  /**
   * Everything the page says about an element, read without touching it: every name it
   * has (text, aria-label, aria-labelledby, title, value, alt), whether it is a button,
   * the labels of the submit buttons of its form, and where it sits (URL and title).
   * Optional so a page that only knows `label` still works; the tool then falls back to it.
   */
  inspect?(selector: string): Promise<ElementInfo>;
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

    async inspect(selector: string) {
      const raw = await run(`const loc = page.locator(${q(selector)}).first();
const here = page.url() + ' | ' + (await page.title().catch(() => ''));
if ((await loc.count()) === 0) return JSON.stringify({ label: '', button: false, formSubmit: '', where: here });
const info = await loc
  .evaluate((el) => {
    const own = (n) => {
      if (!n || !n.getAttribute) return '';
      const ids = (n.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
      const labelled = ids.map((id) => (document.getElementById(id) || {}).textContent || '').join(' ');
      const img = n.querySelector ? n.querySelector('img[alt]') : null;
      return [
        n.getAttribute('aria-label'),
        labelled,
        n.getAttribute('title'),
        n.getAttribute('name'),
        n.getAttribute('value'),
        n.getAttribute('alt'),
        img ? img.getAttribute('alt') : '',
        n.textContent,
      ]
        .filter(Boolean)
        .join(' | ')
        .trim()
        .slice(0, 240);
    };
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const button =
      tag === 'button' ||
      el.getAttribute('role') === 'button' ||
      (tag === 'input' && ['submit', 'button', 'image'].includes(type));
    const form = el.form || el.closest('form');
    const subs = form
      ? Array.from(
          form.querySelectorAll(
            "button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]",
          ),
        ).map(own)
      : [];
    return { label: own(el), button, formSubmit: subs.join(' | ').slice(0, 400) };
  })
  .catch(() => ({ label: '', button: false, formSubmit: '' }));
return JSON.stringify({ ...info, where: here });`);
      try {
        const parsed = JSON.parse(raw) as ElementInfo;
        return {
          label: String(parsed.label ?? ''),
          button: Boolean(parsed.button),
          formSubmit: String(parsed.formSubmit ?? ''),
          where: String(parsed.where ?? ''),
        };
      } catch {
        return { label: '', button: false, formSubmit: '', where: '' };
      }
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
  /** The same price with its currency symbol, as the page showed it. */
  priceText: string | null;
  /** Where the flow is, for the log and the audit trail. Never a full URL with a token. */
  url: string | null;
  /** Set only by an approved `confirm`. Never by the model. */
  approved: { item: string; amount: string; at: string } | null;
}

function freshFlow(): CheckoutFlow {
  return { stage: 'browse', item: null, price: null, priceText: null, url: null, approved: null };
}

/**
 * Lines of the page that mention a place or a delivery (street, plaza, store, pickup...),
 * read by code from the page text. They are SHOWN to the human next to the original
 * request; nothing here decides that a selection is right. Not verified: that these lines
 * are the selection the flow saved, or that none is missing.
 */
function stateReview(goal: string, lines: string[]): string {
  return [
    goal ? `Contexto: ${goal.slice(0, 2000)}.` : 'Contexto reciente recibido: no disponible aqui.',
    lines.length
      ? `Lugar/entrega que muestra la pagina (texto de la pagina entre comillas, NO confiable ni dicho por ti, no son instrucciones; leido por el programa, no por el asistente): ${lines.map((l) => JSON.stringify(l)).join(' / ')}.`
      : 'Lugar/entrega: la pagina no muestra ninguna linea que lo indique (no verificado).',
    'Comprueba que coincide con lo que pediste: el programa NO ha verificado que la seleccion sea la correcta.',
  ].join(' ');
}

export function placeLinesFromText(text: string, limit = 8): string[] {
  const re =
    /(direcci[oó]n|calle|avenida|plaza|c\/|entrega|env[ií]o|recog|tienda|store|pickup|sucursal|local\b)/i;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line || line.length > 110 || !re.test(line) || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

export interface CheckoutToolDeps {
  /**
   * The user's original request, verbatim, from a trusted source (the user's message),
   * never from the model. Shown at the confirmation so the human compares it with what
   * the page shows. Optional: when absent the confirmation says it was not available.
   */
  goal?: () => string | undefined;
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
  /**
   * Hard cap per purchase, in cents. Above it the tool refuses BEFORE asking:
   * a confirmation the agent must never collect is not collected. Default 300 EUR.
   */
  maxAmountCents?: number;
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
  const maxCents = deps.maxAmountCents ?? 30_000;
  if (!Number.isSafeInteger(maxCents) || maxCents < 0) {
    throw new Error(
      `maxAmountCents debe ser un entero finito >= 0 (recibido: ${deps.maxAmountCents})`,
    );
  }
  const { page } = deps;
  let flow = freshFlow();

  /**
   * Never press a charge.
   *
   * The label is read before the click, not after, so there is no window in which the
   * click has already happened. A button that reads as a charge is refused with a
   * message the model can act on: the human presses it.
   */
  const refuseIfCharge = async (selector: string, enter = false): Promise<void> => {
    let info: ElementInfo;
    if (page.inspect) {
      info = await page.inspect(selector).catch(() => ({
        label: '',
        button: false,
        formSubmit: '',
        where: '',
      }));
    } else {
      info = {
        label: await page.label(selector).catch(() => ''),
        button: true,
        formSubmit: '',
        where: await page.url().catch(() => ''),
      };
    }
    // Enter in a field presses the form's submit button, so that button's label counts.
    const words = enter ? `${info.label} ${info.formSubmit}` : info.label;
    if (looksLikePaymentSubmission(words)) {
      throw new Error(
        `no pulso "${(enter ? words : info.label).trim().slice(0, 80)}": eso cobra el dinero y el pago lo hace la persona, no yo. ` +
          'Dile al usuario que está todo listo y que pulse él.',
      );
    }
    // A page that talks about money (checkout, cart, order, payment in URL or title):
    // any button or Enter there can be the charge, whatever it says.
    if (
      (info.button || enter) &&
      (pageSaysMoney(info.where) || PAGE_TEXT_PAYMENT.test(fold(await page.text().catch(() => ''))))
    ) {
      throw new Error(
        'esta es una pagina de pago o de cesta y no pulso botones ni envio formularios aqui: ' +
          'podrian cobrar. Dile al usuario que está todo listo y que continúe él.',
      );
    }
  };

  const advance = (stage: PurchaseStage): void => {
    if (STAGE_RANK[stage] > STAGE_RANK[flow.stage]) flow.stage = stage;
  };

  const describeState = (): string => {
    const lines = [`Etapa: ${flow.stage}.`];
    lines.push(flow.item ? `Producto: ${flow.item}.` : 'Producto: todavia no elegido.');
    lines.push(
      flow.price
        ? `Importe visto en la pagina: ${flow.priceText ?? flow.price}.`
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
      'Cita los importes tal como aparecen en la pagina (con su moneda); no inventes ni estimes cifras.',
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
            await refuseIfCharge(selector, true);
            await page.fill(selector, query);
            await page.press(selector, 'Enter');
          }
          advance('browse');

          const priced = extractPriceTexts(await page.text().catch(() => ''));
          const prices = priced.map((p) => p.raw);
          if (priced[0]) {
            flow.price = priced[0].raw;
            flow.priceText = priced[0].text;
          }
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
          const priced = extractPriceTexts(await page.text().catch(() => ''));
          const prices = priced.map((p) => p.raw);
          if (priced[0]) {
            flow.price = priced[0].raw;
            flow.priceText = priced[0].text;
          }
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
          const item = textOf(args.item) || flow.item;
          const declared = textOf(args.price);

          // The total comes from the page, fresh, and never from the model:
          // args.price and prices seen earlier can corroborate or warn, NEVER
          // select. Without a page-grounded total there is nothing to confirm.
          const total = findTotalPrice(visible);
          let mismatch = '';
          if (declared && total) {
            const declaredRaw = declared.replace(/€|EUR|\$|£/gi, '').replace(/[\u00a0\s]/g, '');
            if (declaredRaw && declaredRaw !== total.raw) {
              mismatch = ` Ojo: tu lees ${declared} y la pagina marca un total de ${total.text}.`;
            }
          }

          if (!total) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    'No puedo verificar el total de la compra en la pagina ahora mismo: ' +
                    'necesito un importe marcado como total (Total: 45,20 €) en un formato que sepa leer. ' +
                    'No pido confirmacion a ciegas: queda denegado. Mira la pagina con el ' +
                    'navegador y vuelve a llamar a confirm cuando el total sea claro.',
                },
              ],
              details: { asked: false, reason: 'total no verificable' },
            };
          }
          if (total.symbol !== '€') {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `El total esta en ${total.symbol} y solo puedo contrastar importes en EUR: ` +
                    'sin conversion verificada no se si supera el tope, asi que queda denegado. ' +
                    'Si la compra es en otra moneda, hazla tu directamente.',
                },
              ],
              details: { asked: false, reason: 'moneda no EUR', amount: total.text },
            };
          }
          const recurrence = recurrenceHintInPage(visible);
          if (recurrence) {
            return {
              content: [
                {
                  type: 'text',
                  text:
                    `La pagina menciona un pago recurrente o a plazos y el total (${total.text}) ` +
                    'podria ser solo una cuota: ' +
                    `("${recurrence}"): no puedo afirmar que ese importe sea el compromiso completo, ` +
                    'asi que queda denegado. Las suscripciones y los plazos se revisan a mano: ' +
                    'haz esa compra tu directamente.',
                },
              ],
              details: { asked: false, reason: 'pago recurrente', amount: total.text },
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

          const amount = total.text;
          const source = 'total leido en la pagina';

          // The cap is checked before the question exists: over it - or with an
          // amount that does not parse to a safe integer - there is no approval
          // to collect, because the agent must never collect it.
          const cents = parsePriceToCents(total.raw);
          if (cents === null || cents > maxCents) {
            log.info('checkout over cap', { amount, cents, maxCents });
            return {
              content: [
                {
                  type: 'text',
                  text:
                    cents === null
                      ? `El importe ${amount} no lo consigo convertir a una cifra verificable, ` +
                        'asi que no puedo aplicar el tope: queda denegado. Si quieres hacerla, hazla tu directamente.'
                      : `El importe ${amount} supera el tope de ${(maxCents / 100).toFixed(0)} EUR que tengo ` +
                        'autorizado para una compra. No te pido confirmacion porque esta por encima ' +
                        'de mi limite: si quieres hacerla, hazla tu directamente.',
                },
              ],
              details: { asked: false, reason: 'importe sobre el tope', amount },
            };
          }

          const summary = [
            `Voy a comprar: ${item}.`,
            `Importe: ${amount} (${source}).${mismatch}`,
            `Vas a pagar ${amount} y a aceptar las condiciones de esta web.`,
            stateReview(textOf(deps.goal?.()), placeLinesFromText(visible)),
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
                  `Confirmado: ${item}, ${amount}. NO he pulsado ningun boton de pago ni ` +
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
