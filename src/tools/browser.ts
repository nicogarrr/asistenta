import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  type BrowserService,
  type ExecJsResult,
  looksLikeCssSelector,
  type TargetResult,
  type WaitResult,
} from '../browser/service.js';
import { normalizeDomain, parseSiteKey, siteKey } from '../gestor/login.js';
import { log, logHost } from '../log.js';
import { isPaymentText } from '../permissions.js';
import { vaultGet } from '../vault.js';

/**
 * The browser tool.
 *
 * One tool, several actions, and the ordering guidance is in the description
 * rather than in enforcement: the model reads the description every turn, and a
 * description that explains "snapshot then target by selector" is what actually
 * changes behaviour. Enforcing a strict action order would only produce blocked
 * calls when the model wanted to look again after clicking.
 *
 * Las acciones tipadas cubren lo común; el JavaScript libre del modelo se retiró
 * Playwright so that the common operations do not require writing JS, while
 * (equivalía a ejecutar código con la sesión del navegador: cookies, ficheros, red).
 */

/**
 * Playback control, as fixed actions rather than code the model writes each time.
 *
 * The reason this exists as fixed actions is a measured failure: the agent was asked
 * to play a song, opened YouTube, and then spent five minutes and eighteen calls
 * picking at a search page while a sponsored result sat at the top and a pre-roll
 * played for twenty seconds. Both failures were selector guessing. Here the knowledge
 * lives in one place, is testable, and cannot drift because the model got creative.
 *
 * `state` and `skip_ad` are NOT here: they are methods on the service, because the
 * watcher needs the same code on a timer and a second copy of the skipper is a
 * second thing that can be wrong. `browser/ads.ts` is the only implementation.
 *
 * The old `skip_ad` script is worth remembering: it mixed Playwright's `:has-text()`
 * into a `document.querySelectorAll` call, which throws. Every skip attempt failed with
 * a SyntaxError and the feature had never worked. The live tests caught it the first
 * time they ran.
 */

const MEDIA_SCRIPTS: Record<string, string> = {
  play: `return await page.evaluate(async () => {
  const v = document.querySelector('video');
  if (!v) return { ok: false, reason: 'no hay video' };
  v.muted = false;
  try { await v.play(); } catch (e) { return { ok: false, reason: String(e).slice(0, 80) }; }
  return { ok: true, playing: !v.paused, currentTime: Math.round(v.currentTime) };
});`,

  pause: `return await page.evaluate(() => {
  const v = document.querySelector('video');
  if (!v) return { ok: false, reason: 'no hay video' };
  v.pause();
  return { ok: true, playing: !v.paused, currentTime: Math.round(v.currentTime) };
});`,

  mute: `return await page.evaluate(() => {
  const v = document.querySelector('video');
  if (!v) return { ok: false, reason: 'no hay video' };
  v.muted = true;
  return { ok: true, muted: v.muted };
});`,

  unmute: `return await page.evaluate(() => {
  const v = document.querySelector('video');
  if (!v) return { ok: false, reason: 'no hay video' };
  v.muted = false;
  return { ok: true, muted: v.muted };
});`,

  seek: `return await page.evaluate((secs) => {
  const v = document.querySelector('video');
  if (!v) return { ok: false, reason: 'no hay video' };
  v.currentTime = secs;
  return { ok: true, currentTime: Math.round(v.currentTime) };
}, __SECONDS__);`,
};

const BrowserParams = Type.Object({
  action: Type.Union([
    Type.Literal('open'),
    Type.Literal('snapshot'),
    Type.Literal('click'),
    Type.Literal('fill'),
    Type.Literal('choose'),
    Type.Literal('press'),
    Type.Literal('wait'),
    Type.Literal('wait_for'),
    Type.Literal('pick'),
    Type.Literal('screenshot'),
    Type.Literal('media'),
    Type.Literal('back'),
    Type.Literal('close'),
  ]),
  what: Type.Optional(
    Type.String({
      description:
        'For media: state | skip_ad | play | pause | mute | unmute | seek. Adverts are ' +
        'skipped automatically in the background; skip_ad is for reporting on one.',
    }),
  ),
  to: Type.Optional(Type.Number({ description: 'For media with what=seek: seconds.' })),
  expect: Type.Optional(
    Type.String({
      description:
        'For click on a selection (store, address, date, plan, option): the text the ' +
        'page MUST show afterwards if the selection matches the user request (e.g. the ' +
        'requested city). The tool checks it itself; if it is missing, the session is ' +
        'locked (no click/choose/fill/press) until you open or go back.',
    }),
  ),
  url: Type.Optional(Type.String({ description: 'For open. Must be http(s).' })),
  selector: Type.Optional(
    Type.String({
      description:
        'CSS or text target for click/fill/press/wait. A selector from the snapshot is ' +
        'best, but plain visible text also works: click/fill accept "Buscar" as well as ' +
        '"#buscar", and if the selector is stale they fall back to role, text and label.',
    }),
  ),
  text: Type.Optional(Type.String({ description: 'For fill and choose: the text to type.' })),
  secret_key: Type.Optional(
    Type.String({
      description:
        'For fill: a vault key site:<dominio>:<campo> (e.g. site:seg-social.es:password). ' +
        'The daemon types the secret straight from the vault, masked end to end: the value ' +
        'never appears to you, in the result or in the transcript. Use it for logins. ' +
        'Mutually exclusive with text.',
    }),
  ),
  option: Type.Optional(
    Type.String({
      description:
        'For choose: the suggestion to pick, if not just the typed text (e.g. "Madrid Chamartín"). Needed when several suggestions match.',
    }),
  ),
  key: Type.Optional(Type.String({ description: 'For press, e.g. "Enter".' })),
  with: Type.Optional(
    Type.String({
      description:
        'For wait/wait_for: what to wait for, a CSS selector or the visible text. For pick: ' +
        'the label to choose from the suggestions, e.g. "Madrid-Chamartín".',
    }),
  ),
  from: Type.Optional(
    Type.String({
      description: 'For pick: the field to write in, a selector or its label. Required by pick.',
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      description: 'For wait, pick, click and fill. Default 3000, maximum 30000.',
    }),
  ),
  fullPage: Type.Optional(Type.Boolean({ description: 'For screenshot.' })),
  send: Type.Optional(
    Type.Boolean({
      description:
        'For screenshot: also send the image to the user in the chat. Use it when the user asks for a capture of what you are doing in the browser.',
    }),
  ),
  visible: Type.Optional(
    Type.Boolean({
      description:
        'For open. Put the window on screen instead of headless. Pass ' +
        'visible: true whenever the user might want to WATCH the task happen - it is the ' +
        'default you should use when the user says "you do it" or "let me see". Without ' +
        'it the browser is headless and the user sees NOTHING at all. Every result tells ' +
        'you which one is in use. Also REQUIRED for any media: a headless browser has no ' +
        'audio output, so a video "plays" in silence and you would be lying if you said ' +
        'the user can hear it.',
    }),
  ),
});

/**
 * Script for action=fill that verifies what ended up in the field.
 *
 * Autocomplete widgets (Renfe's station boxes, for one) react to the typed text and
 * can leave "MadridMadrid" or a stale suggestion in the input. A bare `fill` reports
 * success anyway, and the agent then searched with a broken origin and gave up. Now
 * the value is read back; when it differs it is cleared and typed again key by key
 * once, and the result states the final value so the agent can see a mismatch
 * instead of assuming it worked.
 */
/** Scopes whose last declared selection expectation failed. Enforced in code. */
const selectionLocked = new Set<string>();

export function buildFillScript(selector: string, value: string): string {
  return fillScriptFor(`page.locator(${JSON.stringify(selector)}).first()`, selector, value);
}

/**
 * The same read-back fill, for a field that was resolved by role, text or label rather
 * than by a CSS selector.
 *
 * There is no honest way to turn "the button labelled Destino" back into a selector, and
 * inventing one is how a fill ends up typing into the wrong box. The resolver hands over
 * the exact expression that found the element instead, and this script uses it.
 */
export function buildFillScriptFor(locatorJs: string, label: string, value: string): string {
  return fillScriptFor(locatorJs, label, value);
}

/** Body shared by both builders: fill, read back, and retry once by retyping. */
function fillScriptFor(locatorJs: string, label: string, value: string): string {
  const val = JSON.stringify(value);
  const named = JSON.stringify(label);
  return `const loc = ${locatorJs};
const want = ${val};
const norm = (t) => String(t ?? '').trim().toLowerCase();
await loc.fill(want);
await page.waitForTimeout(300);
let got = await loc.inputValue().catch(() => want);
let retried = false;
if (norm(got) !== norm(want)) {
  retried = true;
  await loc.fill('');
  await loc.click();
  await loc.press('Control+A');
  await loc.press('Delete');
  await loc.pressSequentially(want, { delay: 60 });
  await page.waitForTimeout(500);
  got = await loc.inputValue().catch(() => want);
}
if (norm(got) !== norm(want)) {
  return 'ATENCIÓN: el campo ' + ${named} + ' quedó con "' + got + '" en lugar de "' + want + '". Revisa el autocompletado antes de continuar.';
}
return 'filled ' + ${named} + (retried ? ' (reintentado tras limpiar el campo)' : '');`;
}

/**
 * The secret fill channel (fill with `secret_key`) as a FIXED protocol, not a
 * text: the script returns one status TOKEN from a closed set and the tool
 * maps it to a fixed Spanish message. No page-derived string ever crosses -
 * there is nothing to censor, so no partial or escaped fragment of the value
 * can leak through an unknown string.
 *
 * Mechanics, hardened:
 *
 * - Origin binding on a STABLE element: the locator resolves ONCE to an
 *   element handle, and the origin check and the typing run on that same
 *   element in that same frame. A navigation or swap detaches the handle and
 *   every later operation throws, which aborts - it can never retarget the
 *   secret into a new frame. The check also runs again AFTER the write,
 *   before verification.
 * - NO keyboard retry: typing is focus-based and not atomic, so a page can
 *   redirect the remaining characters mid-type. A failed exact fill is a
 *   mismatch for a human, not a retry.
 * - The origin must be https (localhost excepted) on the key's canonical
 *   domain or a subdomain. No URL constructor: the vm sandbox this runs in
 *   has no URL global, so the href is parsed by hand.
 * - Every page operation sits in its own try/catch: Playwright errors can
 *   quote the typed value in their call logs, so no error text leaves here.
 * - Verification is honest: a read-back that cannot run is error_verify,
 *   never an invented match. The comparison is EXACT (a password's case and
 *   spaces are the password).
 */
export type SecretFillStatus =
  | 'filled'
  | 'rejected_origin'
  | 'aborted_after_write'
  | 'error_write'
  | 'error_verify'
  | 'mismatch';

export const SECRET_FILL_STATUSES: readonly SecretFillStatus[] = [
  'filled',
  'rejected_origin',
  'aborted_after_write',
  'error_write',
  'error_verify',
  'mismatch',
];

/** The fixed message for a status token. Inputs are the key's domain only. */
export function secretFillMessage(status: string, domain: string): string {
  switch (status as SecretFillStatus) {
    case 'filled':
      return 'Campo rellenado con el valor del vault (no mostrado).';
    case 'rejected_origin':
      return `RECHAZADO: el campo no está en ${domain} (origen distinto, ilegible o no seguro). No se ha escrito nada.`;
    case 'aborted_after_write':
      return (
        'ATENCIÓN: se intentó escribir el valor del vault y la página cambió durante la operación; ' +
        'se detuvo antes de verificar. Puede haber texto parcial en el campo: revísalo antes de continuar. ' +
        'El valor no se muestra.'
      );
    case 'error_write':
      return 'ATENCIÓN: no se pudo escribir en el campo (valor del vault, no mostrado).';
    case 'error_verify':
      return 'ATENCIÓN: se intentó escribir pero no se pudo verificar el contenido del campo (valor del vault, no mostrado).';
    case 'mismatch':
      return (
        'ATENCIÓN: el campo no quedó con el valor del vault. No se reintenta con el teclado por seguridad ' +
        '(el foco puede cambiar a mitad de la escritura). Revisa el campo (autocompletado, gestor de ' +
        'contraseñas) antes de continuar; el valor no se muestra por seguridad.'
      );
    default:
      // An unknown token says the channel was tampered or broke: fail closed.
      return 'ATENCIÓN: no se pudo verificar el campo (valor del vault, no mostrado).';
  }
}

/** Whether the status means the value actually landed in the field. */
export function secretFillOk(status: string): boolean {
  return status === 'filled';
}

export function buildFillScriptMasked(locatorJs: string, value: string, domain: string): string {
  const val = JSON.stringify(value);
  const dom = JSON.stringify(domain);
  return `const loc = ${locatorJs};
const want = ${val};
const expected = ${dom};
const parse = (href) => {
  const m = /^([a-z][a-z0-9+.-]*):\\/\\/([^/?#]*)/i.exec(String(href ?? ''));
  if (!m) return null;
  let h = m[2];
  const at = h.lastIndexOf('@');
  if (at !== -1) h = h.slice(at + 1);
  const colon = h.indexOf(':');
  if (colon !== -1) h = h.slice(0, colon);
  return { proto: m[1].toLowerCase(), host: h.toLowerCase() };
};
const onExpected = (u) => {
  if (!u) return false;
  const hh = u.host.replace(/^www\\./, '');
  const local = hh === 'localhost' || hh === '127.0.0.1';
  if (u.proto !== 'https' && !local) return false;
  return hh === expected || hh.endsWith('.' + expected);
};
let el;
try {
  el = await loc.elementHandle();
} catch {
  return 'error_write';
}
if (!el) return 'error_write';
const frameOk = async () => {
  try {
    return onExpected(parse(await el.evaluate(() => String(location.href))));
  } catch {
    return false;
  }
};
if (!(await frameOk())) return 'rejected_origin';
try {
  await el.fill(want);
} catch {
  // fill rejected before applying: no write was confirmed.
  return 'error_write';
}
// A write WAS attempted. From here on no message may claim nothing was written.
try {
  await page.waitForTimeout(300);
} catch {
  return 'aborted_after_write';
}
if (!(await frameOk())) return 'aborted_after_write';
let got;
try {
  got = await el.evaluate((e) => (e && typeof e.value === 'string' ? e.value : null));
} catch {
  return 'error_verify';
}
if (got === null) return 'error_verify';
if (got !== want) return 'mismatch';
return 'filled';`;
}

/**
 * After an action, check whether the page is a bot challenge or captcha, and if so stop
 * and hand it to the person. Returns text for the model to relay, or null on a normal page.
 *
 * The agent never tries to solve it: the first time, the user gets a screenshot in the
 * chat and the page in a visible window of the same profile; later checks while it is
 * still on screen only say that it is still waiting. The wording is honest about each
 * step that did not work, and tells the model not to report the task as done.
 */
export async function challengeNote(
  service: BrowserService,
  scope: string,
  sendImage?: (png: Buffer) => Promise<boolean>,
): Promise<{ text: string; kind: string } | null> {
  const found = await service.detectChallenge(scope);
  if (!found) return null;
  let host = found.url;
  try {
    host = new URL(found.url).hostname;
  } catch {
    // keep the raw url
  }
  const head = `captcha_detectado (${found.kind}) en ${host}. No intento saltármelo.`;
  const tail =
    'No digas que la tarea está hecha: sigue bloqueada hasta que el usuario lo resuelva y lo confirme; entonces haz snapshot para comprobar que ya no aparece.';
  if (service.isVisible(scope)) {
    return {
      kind: found.kind,
      text: `${head} Sigue en pantalla esperando a que el usuario lo resuelva. ${tail}`,
    };
  }
  let sent = false;
  if (sendImage) {
    try {
      const shot = await service.screenshot(scope);
      sent = await sendImage(Buffer.from(shot.data, 'base64')).catch(() => false);
    } catch {
      sent = false;
    }
  }
  const shown = await service.handToUser(scope);
  const parts = [
    head,
    sent
      ? 'He enviado una captura al usuario.'
      : 'No pude enviar la captura al usuario; díselo tú.',
    shown
      ? 'He abierto la página en una ventana visible: debe resolverlo ahí y avisarte ("listo").'
      : 'No pude abrir la ventana visible; dile que abra esa página él mismo.',
    tail,
  ];
  return { kind: found.kind, text: parts.join(' ') };
}

/** Separator the approval text knows: element description, then the text of its card. */
export const CONTEXT_MARK = '\nCONTEXTO DEL ELEMENTO:\n';

export function createBrowserTool(
  service: BrowserService,
  scopeOf: () => string,
  sendImage?: (png: Buffer) => Promise<boolean>,
): AgentTool<typeof BrowserParams> & {
  gateHint: (args: Record<string, unknown>) => Promise<string>;
} {
  return {
    name: 'browser',
    label: 'Browser',
    description: [
      'Control a real browser. Prefer this over the computer tool for any web page:',
      'it has the DOM, so you target elements instead of guessing pixels.',
      '',
      'How to work:',
      '1. action=open with the url. NEVER invent a deep url from memory: go to the site',
      '   root (https://site.com) and navigate from there with links and searches. If a url',
      '   404s, the browser has already retried from the home page for you and the result',
      '   says so (retryFromRoot).',
      '2. action=snapshot to list the interactive elements. Each line gives the selector,',
      '   what kind of control it is, its ARIA role, the value a field currently holds, and',
      '   its [index]. If a field has suggestions open it says so on that field line and at',
      '   the top of the snapshot.',
      '3. action=click / fill / press with a selector from that snapshot. You may also pass',
      '   the visible text instead of a selector; it is resolved by role, then text, then',
      '   label, then by similarity, and a miss lists the closest things that do exist.',
      '4. action=screenshot only when you need to see something a selector cannot',
      '   express (canvas, a video, a rendered image, an unexpected layout).',
      '',
      'DROPDOWNS AND AUTOCOMPLETE - USE action=choose, NOT fill plus a click:',
      '  action=choose selector="#origen" text="Madrid"',
      '  action=choose selector="#origen" text="Madrid" option="Madrid-Chamartin"',
      'It types, waits for the suggestions to appear, picks the one that matches by text and',
      'reads the field back to verify it. If several suggestions match it hands the list',
      'back instead of guessing, so repeat it with option set to the one you want. It is',
      'safe to call twice. This is not optional on any site with a suggestion box: those',
      'panels appear a few hundred milliseconds after the field is focused, and reading the',
      'page too early is why an agent decides there is nothing to click.',
      '',
      'WAITING - USE action=wait, NOT a blind sleep:',
      '  action=wait with="#results" timeoutMs=4000     (a CSS selector)',
      '  action=wait with="Sin resultados" timeoutMs=2000 (visible text)',
      'It polls the page until the element exists and is visible, and tells you how long it',
      'took. If it never appears it does not throw: it tells you what it waited for and what',
      'is on the page now, which is what you need to decide the next step. Default 3000ms,',
      'maximum 30000. action=wait_for is the same action under the other name.',
      '',
      'VISIBLE OR NOT - the user must never be left watching nothing:',
      'The browser is HEADLESS unless you pass visible: true, and a headless browser shows',
      'the user nothing at all. Pass visible: true on the first open whenever the user asked',
      'you to do something they might want to see ("busca un tren", "reservame esto", "hazlo',
      'tu"), and keep it for the rest of the task. Every result repeats whether the window',
      'is visible, so you can check instead of guessing. If it is headless and you want the',
      'user to see something, either reopen with visible: true or send a screenshot.',
      '',
      'LOGINS: never ask the user for a password or type one they pasted. Credentials',
      'live in the vault as site:<dominio>:username and site:<dominio>:password; fill with',
      'secret_key types them straight from the vault, masked - you never see the value. If',
      'the key is missing the error names the exact `pa vault set` command for the user.',
      '',
      'CAPTCHAS: after open / click / press / snapshot the result may start with',
      '"captcha_detectado". That means a human check (Cloudflare, reCAPTCHA, hCaptcha...) is',
      'blocking the page. Do NOT try to solve or bypass it and do not retry in a loop: the',
      'user has already been sent a screenshot and the page is open on their screen. Tell',
      'them plainly that it is waiting for them, and continue only after they say it is done.',
      '',
      'action=media controls playback on any page with a video element. what=state',
      'reports what is playing, whether an advert is on screen and how many adverts have',
      'already been skipped automatically; what=skip_ad presses the skip button right now and',
      'reports which selector matched. Also play | pause | mute | unmute | seek.',
      '',
      'ADVERTS ARE SKIPPED FOR YOU. A background watcher presses the skip button the moment',
      'it appears, so you do not have to ask and the agent does not have to notice. Call',
      'what=state only if the user asks whether there was an advert, and what=skip_ad only if',
      'the watcher is somehow not keeping up.',
      '',
      'WHEN SEARCHING A VIDEO SITE: go straight to the video if you already know it. If',
      'you must search, NEVER click a result marked "Patrocinado", "Ad", "Anuncio" or',
      '"Sponsored" - that is paid placement, not what the user asked for. Pick the',
      'result whose title matches the request and whose channel looks like the real one.',
      '',
      'IMPORTANT - SOUND: a headless browser has NO audio output device. Music and',
      'video can play in the DOM and be completely silent on the PC. Whenever the user',
      'wants to hear something (a song, a video, a sound), pass visible: true so a real',
      'window opens with real audio. Never claim something is audible unless you opened',
      'a visible window, and never claim an action worked without checking.',
      '',
      'REPORTING: a tool result that says ok:false is not the end of the task. Read what it',
      'says, then act on the candidates it lists. Do not claim you did something you did',
      'not verify, and never say you finished because a tool returned data.',
      '',
      'AFTER A SELECTION, VERIFY IT: when you pick a place, store, product, size or option, read the',
      'page back (snapshot or the summary panel) and compare what it now shows with what the user',
      'asked for. A map or a search box showing the right place does not prove the selection that',
      'was actually saved. If the page shows something different (another city, another item), stop',
      'and say so; do not continue the order on the wrong selection.',
      'Never type credentials or card numbers into a page.',
    ].join('\n'),
    parameters: BrowserParams,
    // Sequential: the page is one shared object, and two actions in flight at once
    // race on the same navigation.
    executionMode: 'sequential',
    // Read by the agent before the permission gate runs: the page's own words about the
    // element the model is about to act on.
    gateHint: async (args: Record<string, unknown>) => {
      const action = String(args.action ?? '');
      const selector = typeof args.selector === 'string' ? args.selector : '';
      if (!selector || !['click', 'fill', 'press', 'choose'].includes(action)) return '';
      const base = await service.describeTarget(scopeOf(), selector);
      // A selection (store, product, option) is judged by the card it belongs to, not by
      // the button's own label: show that card's text next to the element.
      const ctx =
        action === 'click' || action === 'choose'
          ? await service.describeContext(scopeOf(), selector).catch(() => '')
          : '';
      const target = ctx ? `${base}${CONTEXT_MARK}${ctx}` : base;
      // Only for targets that read like money: the confirmation shows what is being paid.
      if (!isPaymentText(target)) return target;
      const summary = await service.summarisePage(scopeOf()).catch(() => '');
      return summary ? `${target}\nRESUMEN DE LA PÁGINA:\n${summary}` : target;
    },
    execute: async (_id, args) => {
      const scope = scopeOf();
      const record = args as unknown as Record<string, unknown>;
      if (
        selectionLocked.has(scope) &&
        ['click', 'choose', 'fill', 'press'].includes(String(args.action))
      ) {
        throw new Error(
          'SELECCION_NO_CORROBORADA: la última selección no mostró el texto esperado. ' +
            'Acciones bloqueadas; informa de la discrepancia al usuario, o usa open/back para reiniciar.',
        );
      }
      if (args.action === 'open' || args.action === 'back') selectionLocked.delete(scope);

      switch (args.action) {
        case 'open': {
          const url = String(record.url ?? '');
          if (!url) throw new Error('la acción open necesita una url');
          const info = await service.open(scope, url, { visible: Boolean(record.visible) });
          log.info('browser open', {
            host: logHost(info.url),
            status: info.status,
            retryFromRoot: info.retryFromRoot ?? false,
          });
          const note = await challengeNote(service, scope, sendImage);
          const body = [`Opened ${info.url}\nTitle: ${info.title}\nHTTP ${info.status ?? '?'}`];
          if (info.retryFromRoot) {
            body.push('The deep url 404d, so this is the site root: navigate from here.');
          }
          if (info.note) body.push(info.note);
          if (note) body.unshift(note.text);
          return {
            content: [{ type: 'text', text: `${body.join('\n')}${visibleNote(info.visible)}` }],
            details: note ? { ...info, captcha: note.kind } : info,
          };
        }

        case 'snapshot': {
          const text = await service.snapshot(scope);
          const note = await challengeNote(service, scope, sendImage);
          return {
            content: [
              {
                type: 'text',
                text: `${note ? `${note.text}\n` : ''}${text}${visibleNote(windowVisible(service, scope))}`,
              },
            ],
            details: {
              lines: text.split('\n').length,
              visible: windowVisible(service, scope),
              ...(note ? { captcha: note.kind } : {}),
            },
          };
        }

        case 'click': {
          const target = requireTarget(record);
          const result = await service.clickTarget(scope, target, {
            timeoutMs: readTimeout(record),
          });
          const note = await challengeNote(service, scope, sendImage);
          let said = describeTarget(result, { done: 'clicked', missing: 'hacer clic en' });
          const expected = record.expect === undefined ? '' : String(record.expect);
          if (expected) {
            await new Promise((r) => setTimeout(r, 800));
            if (await service.pageShows(scope, expected).catch(() => false)) {
              said += `\nSELECCION_CORROBORADA: la página muestra "${expected}".`;
            } else {
              selectionLocked.add(scope);
              said += `\nSELECCION_NO_CORROBORADA: la página NO muestra "${expected}" tras el clic. Acciones bloqueadas.`;
            }
          }
          return {
            content: [
              {
                type: 'text',
                text: `${note ? `${note.text}\n` : ''}${said}${visibleNote(result.visible)}`,
              },
            ],
            details: { ...result, ...(note ? { captcha: note.kind } : {}) },
          };
        }

        case 'fill': {
          const target = requireTarget(record);
          const secretKey =
            record.secret_key === undefined ? undefined : String(record.secret_key).trim();
          let value: string;
          let canonicalKey: string | undefined;
          let secretDomain: string | undefined;
          if (secretKey !== undefined) {
            if (record.text !== undefined) {
              throw new Error('la acción fill acepta text o secret_key, no ambos');
            }
            const parsed = parseSiteKey(secretKey);
            if (!parsed) {
              throw new Error(
                'secret_key debe tener la forma site:<dominio>:<campo> ' +
                  '(p. ej. site:seg-social.es:password).',
              );
            }
            // Canonical form: casing in the argument cannot desync from the
            // vault, where keys live in convention lowercase.
            canonicalKey = siteKey(parsed.domain, parsed.field);
            secretDomain = parsed.domain;
            // The key is bound to its origin BEFORE the vault is touched:
            // typing a secret into the wrong page is the one failure no retry
            // undoes. The owning frame is checked again inside the script.
            const probe = await service
              .execJs(scope, 'return String(page.url());')
              .catch(() => null);
            const pageDomain = probe?.text ? normalizeDomain(probe.text) : null;
            if (
              !pageDomain ||
              (pageDomain !== secretDomain && !pageDomain.endsWith(`.${secretDomain}`))
            ) {
              throw new Error(
                `Rechazado: la página actual no es ${secretDomain}. ` +
                  'No se ha tocado el vault ni se ha escrito nada.',
              );
            }
            const stored = await vaultGet(canonicalKey);
            if (stored === undefined) {
              throw new Error(
                `El vault no tiene ningún secreto con la clave ${canonicalKey}. ` +
                  `Nico lo guarda con: pa vault set ${canonicalKey} <valor>`,
              );
            }
            value = stored;
          } else {
            value = String(record.text ?? '');
            if (!value) throw new Error('la acción fill necesita text');
          }
          // Resolved first, and through the same rescue chain as click: a stale
          // selector used to be the end of the turn. The fill itself still goes through
          // the read-back script, which is what catches an autocomplete that mangles
          // what was typed.
          const resolved = await service.resolveTarget(scope, target, {
            timeoutMs: readTimeout(record),
          });
          const secretDetails = canonicalKey ? { secret_key: canonicalKey } : { value };
          if (!resolved.ok) {
            // Secret path: the closed-channel rule covers every exit, so the
            // resolution payload (page-derived) does not cross either - fixed
            // message and allowlist details here as well.
            if (canonicalKey) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `No se encontró el campo para escribir el secreto (clave ${canonicalKey}, valor no mostrado).`,
                  },
                ],
                details: { secret_key: canonicalKey, visible: Boolean(resolved.visible) },
                isError: true,
              };
            }
            return {
              content: [
                {
                  type: 'text',
                  text: `${describeTarget(resolved, { done: 'filled', missing: 'encontrar el campo para escribir en' })}${visibleNote(resolved.visible)}`,
                },
              ],
              details: { ...resolved, ...secretDetails },
            };
          }
          if (canonicalKey && secretDomain) {
            // Dedicated secret channel, FIXED PROTOCOL: the script returns one
            // status token from a closed set and the message comes from a
            // fixed map - no page-derived string crosses, so there is nothing
            // to censor (a partial or escaped fragment of the value cannot
            // leak through an unknown string). Errors never propagate verbatim
            // (Playwright can quote the typed value in its call logs), details
            // are an allowlist, and nothing on this path logs code, value or
            // error.
            let status: string;
            try {
              const res: ExecJsResult = await service.execJs(
                scope,
                buildFillScriptMasked(resolved.locatorJs, value, secretDomain),
              );
              status = res.text.trim();
            } catch {
              throw new Error('No se pudo escribir el secreto (valor del vault, no mostrado).');
            }
            // An unknown token is never echoed anywhere: it could carry a
            // fragment of the value, so details record 'unknown' and the
            // message map fails closed.
            const known = SECRET_FILL_STATUSES.includes(status as SecretFillStatus)
              ? status
              : 'unknown';
            const ok = secretFillOk(known);
            return {
              content: [
                {
                  type: 'text',
                  text: `${secretFillMessage(status, secretDomain)}${resolved.how === 'selector' ? '' : ` (resolved as ${resolved.how})`}${visibleNote(resolved.visible)}`,
                },
              ],
              details: {
                secret_key: canonicalKey,
                status: known,
                visible: Boolean(resolved.visible),
                resolvedAs: resolved.how,
              },
              isError: !ok,
            };
          }
          const text = await service.execJs(
            scope,
            buildFillScriptFor(resolved.locatorJs, resolved.selector ?? target, value),
          );
          return {
            content: [
              {
                type: 'text',
                text: `${text.text}${resolved.how === 'selector' ? '' : ` (resolved as ${resolved.how})`}${visibleNote(resolved.visible)}`,
              },
            ],
            details: { ...resolved, ...secretDetails, filled: text.text },
          };
        }

        // Autocomplete / combobox fields (stations, cities, addresses): types, reads the
        // suggestions, picks one by text and reads the field back. Works on any page.
        case 'choose': {
          const selector = requireTarget(record);
          const value = String(record.text ?? '');
          if (!value) throw new Error('la acción choose necesita text');
          const option = record.option === undefined ? undefined : String(record.option);
          const r = await service.autocomplete(scope, selector, value, option);
          return {
            content: [{ type: 'text', text: r.message }],
            details: { selector, ok: r.ok, value: r.value, suggestions: r.suggestions },
          };
        }

        case 'press': {
          const target = requireTarget(record);
          const key = String(record.key ?? 'Enter');
          const resolved = await service.resolveTarget(scope, target, {
            timeoutMs: readTimeout(record),
          });
          if (!resolved.ok) {
            return {
              content: [
                {
                  type: 'text',
                  text: `${describeTarget(resolved, { done: 'pressed', missing: 'encontrar el elemento' })}${visibleNote(resolved.visible)}`,
                },
              ],
              details: { ...resolved, key },
            };
          }
          const text = await service.execJs(
            scope,
            `await ${resolved.locatorJs}.press(${JSON.stringify(key)});
return 'pressed ' + ${JSON.stringify(key)} + ' on ' + ${JSON.stringify(resolved.how)} + ' (${resolved.how})';`,
          );
          const note = await challengeNote(service, scope, sendImage);
          return {
            content: [
              {
                type: 'text',
                text: `${note ? `${note.text}\n` : ''}${text.text}${visibleNote(resolved.visible)}`,
              },
            ],
            details: { ...resolved, key, ...(note ? { captcha: note.kind } : {}) },
          };
        }

        case 'wait':
        case 'wait_for': {
          const { selector, text } = waitTarget(record);
          if (!selector && !text) {
            throw new Error(
              'la accion wait necesita with= (un selector o el texto que esperas), ' +
                'por ejemplo with="#resultados" o with="Sin resultados"',
            );
          }
          const result = await service.waitFor(scope, { selector, text }, readTimeout(record));
          return {
            content: [
              {
                type: 'text',
                text: `${describeWait(result)}${visibleNote(result.visible)}`,
              },
            ],
            details: { ...result },
          };
        }

        case 'screenshot': {
          const shot = await service.screenshot(scope, Boolean(record.fullPage));
          // The user asked to SEE it: the image only reaches the model unless it is
          // sent to the chat. The result says plainly whether it got there.
          let delivery = '';
          if (record.send) {
            if (!sendImage) {
              delivery = ' No se pudo enviar al usuario: este canal no admite imágenes.';
            } else {
              const ok = await sendImage(Buffer.from(shot.data, 'base64')).catch(() => false);
              delivery = ok
                ? ' Enviada al usuario.'
                : ' ERROR: no se pudo enviar la imagen al usuario; díselo.';
            }
          }
          const visible = windowVisible(service, scope);
          return {
            content: [
              {
                type: 'text',
                text: `Screenshot of the current page${record.fullPage ? ' (full page)' : ''}.${delivery}${visibleNote(visible)}`,
              },
              { type: 'image', mimeType: shot.mimeType, data: shot.data },
            ],
            details: {
              fullPage: Boolean(record.fullPage),
              sent: delivery.includes('Enviada'),
              visible,
            },
          };
        }

        case 'media': {
          const what = String(record.what ?? 'state');
          // Media implies sound, and sound needs a real window, so every media call
          // promotes the session to visible. Done here rather than trusting the model
          // to pass visible: true, because the failure it prevents is the agent saying
          // it is playing music the user cannot hear.
          if (what === 'state') {
            const state = await service.mediaState(scope);
            const auto = service.adSkipStats(scope);
            return {
              content: [
                {
                  type: 'text',
                  text: `${JSON.stringify(state)}\nSaltados automaticamente: ${auto.skipped} en ${auto.polls} comprobaciones.`,
                },
              ],
              details: {
                ...state,
                autoSkipped: auto.skipped,
                autoPolls: auto.polls,
                visible: true,
              },
            };
          }
          if (what === 'skip_ad') {
            const result = await service.skipAdNow(scope);
            return {
              content: [
                {
                  type: 'text',
                  text:
                    result.clicked > 0
                      ? `Saltado: ${result.clicked} boton(es). (${result.total} en total esta sesion)`
                      : 'No hay ningun boton de saltar visible ahora mismo. Si el anuncio no es saltable, solo cabe esperar.',
                },
              ],
              details: { ...result, visible: true },
            };
          }
          const script = MEDIA_SCRIPTS[what];
          if (!script) throw new Error(`media no entiendo "${what}"`);
          const result = await service.execJs(
            scope,
            script.replace('__SECONDS__', String(Math.max(0, Number(record.to ?? 0)))),
            { visible: record.visible !== false },
          );
          return {
            content: [
              { type: 'text', text: `${result.text || '(sin datos)'}${visibleNote(true)}` },
            ],
            details: { what, timedOut: result.timedOut, visible: true },
          };
        }

        case 'back': {
          const info = await service.back(scope);
          const visible = windowVisible(service, scope);
          return {
            content: [
              {
                type: 'text',
                text: `Now at ${info.url}\nTitle: ${info.title}${visibleNote(visible)}`,
              },
            ],
            details: { ...info, visible },
          };
        }

        case 'close': {
          await service.close(scope);
          return {
            content: [{ type: 'text', text: 'Browser closed. The profile is kept on disk.' }],
            details: { visible: false },
          };
        }

        default:
          throw new Error(`acción desconocida: ${String(args.action)}`);
      }
    },
  };
}

/**
 * What to act on: `selector` if the model was explicit, otherwise `with` or `text`.
 *
 * Every action accepts the same three names on purpose. A model that typed
 * `selector=Buscar` and a model that typed `with=Buscar` are both expressing the same
 * intent, and making one of them fail on a parameter name is a wasted turn.
 */
function requireTarget(record: Record<string, unknown>): string {
  const selector = String(record.selector ?? '').trim();
  if (selector) return selector;
  const withValue = String(record.with ?? '').trim();
  if (withValue) return withValue;
  const text = String(record.text ?? '').trim();
  if (text) return text;
  throw new Error(
    'esta acción necesita un objetivo: selector= (o with=) con un selector del snapshot ' +
      'o con el texto que se ve en la pantalla. Usa action=snapshot para verlos.',
  );
}

/**
 * Split the `wait` target into the two things it could mean.
 *
 * `#resultados` is a selector and `Sin resultados` is text; both are plausible readings
 * of the same argument, so a value that only looks like text is also tried as text and
 * the service reports which one matched.
 */
function waitTarget(record: Record<string, unknown>): { selector: string; text: string } {
  const explicit = String(record.selector ?? '').trim();
  if (explicit) return { selector: explicit, text: '' };
  const withValue = String(record.with ?? record.text ?? '').trim();
  if (!withValue) return { selector: '', text: '' };
  return looksLikeCssSelector(withValue)
    ? { selector: withValue, text: '' }
    : { selector: '', text: withValue };
}

/** The model-supplied timeout, or the service default when it did not say. */
function readTimeout(record: Record<string, unknown>): number | undefined {
  const raw = Number(record.timeoutMs);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/**
 * Whether the user can see the browser.
 *
 * Tolerates a service that cannot answer, because a status line is not worth failing a
 * call over: the cost of being wrong is one slightly misleading word in the footer.
 */
function windowVisible(service: BrowserService, scope: string): boolean {
  try {
    return service.isVisible(scope);
  } catch {
    return false;
  }
}

/**
 * The same sentence on every result, so the model never has to remember whether this
 * chat's window is on screen.
 *
 * Without it the agent narrates "he abierto la página" to a user who is watching an
 * empty screen. With it, the model has the fact and can decide to reopen it visible or
 * to send a screenshot instead.
 */
function visibleNote(visible: boolean): string {
  return visible
    ? '\nVentana del navegador: VISIBLE. El usuario está viendo esto en su pantalla.'
    : '\nVentana del navegador: headless. El usuario no ve nada; si quiere verlo, ' +
        'reabre con visible: true o mándale una captura con send.';
}

/**
 * Text for a click/fill/press: what was done, or the failure the service already
 * wrote in Spanish with the closest candidates attached.
 */
function describeTarget(result: TargetResult, what: { done: string; missing: string }): string {
  if (!result.ok) return result.error ?? `No he podido ${what.missing} "${result.target}".`;
  return `${what.done} "${result.target}" (${result.how}) en ${result.waitedMs}ms.`;
}

/** Text for a wait: success says how long it took, failure says what is there instead. */
function describeWait(result: WaitResult): string {
  if (result.ok) {
    return `"${result.waitedFor}" ha aparecido y es visible (${result.waitedMs}ms). Ya puedes actuar sobre él.`;
  }
  return result.reason ?? `"${result.waitedFor}" no ha aparecido.`;
}

/**
 * A script can return a screenshot as a marker line, e.g.
 * `return { shot: await page.screenshot() }` is too heavy, so the documented way is
 * to return the string `__shot__<base64>`. Parsing it here keeps the escape hatch
 * usable without teaching the model a second tool call.
 */
export function extractScreenshot(text: string): string | null {
  const match = /__shot__([A-Za-z0-9+/=]{32,})/.exec(text);
  return match?.[1] ?? null;
}
