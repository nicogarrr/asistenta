import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  type BrowserService,
  looksLikeCssSelector,
  type PickResult,
  type TargetResult,
  type WaitResult,
} from '../browser/service.js';
import { log } from '../log.js';

/**
 * The browser tool.
 *
 * One tool, several actions, and the ordering guidance is in the description
 * rather than in enforcement: the model reads the description every turn, and a
 * description that explains "snapshot then target by selector" is what actually
 * changes behaviour. Enforcing a strict action order would only produce blocked
 * calls when the model wanted to look again after clicking.
 *
 * `exec_js` is the whole point. Everything else here is a convenience wrapper over
 * Playwright so that the common operations do not require writing JS, while
 * `exec_js` covers everything Playwright can do and anything the wrappers miss.
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
    Type.Literal('press'),
    Type.Literal('wait'),
    Type.Literal('wait_for'),
    Type.Literal('pick'),
    Type.Literal('screenshot'),
    Type.Literal('exec_js'),
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
  url: Type.Optional(Type.String({ description: 'For open. Must be http(s).' })),
  selector: Type.Optional(
    Type.String({
      description:
        'CSS or text target for click/fill/press/wait. A selector from the snapshot is ' +
        'best, but plain visible text also works: click/fill accept "Buscar" as well as ' +
        '"#buscar", and if the selector is stale they fall back to role, text and label.',
    }),
  ),
  text: Type.Optional(Type.String({ description: 'For fill.' })),
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
  code: Type.Optional(
    Type.String({
      description:
        'For exec_js. JavaScript with `page` (a Playwright Page) and `state` (an object ' +
        'that persists between calls) in scope. Return a value and it comes back ' +
        'formatted. Use `state.x = ...` to remember something between calls.',
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
        'For open and exec_js. Put the window on screen instead of headless. Pass ' +
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

export function createBrowserTool(
  service: BrowserService,
  scopeOf: () => string,
  sendImage?: (png: Buffer) => Promise<boolean>,
): AgentTool<typeof BrowserParams> {
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
      '   its [index]. If there are suggestions open it says so at the top.',
      '3. action=click / fill / press with a selector from that snapshot. You may also pass',
      '   the visible text instead of a selector; it is resolved by role, then text, then',
      '   label, then by similarity, and a miss lists the closest things that do exist.',
      '4. action=screenshot only when you need to see something a selector cannot',
      '   express (canvas, a video, a rendered image, an unexpected layout).',
      '',
      'DROPDOWNS AND AUTOCOMPLETE - USE action=pick, NOT fill plus a click:',
      '  action=pick with="Madrid-Chamartín" from="#origen"',
      'It focuses the field, waits for the suggestions to appear, reads them, presses the',
      'one that matches and verifies the field really changed. If the label is not in the',
      'list it comes back with the options that did appear, so you can retry with one of',
      'them. It is safe to call twice. This is not optional on any site with a suggestion',
      'box: those panels appear a few hundred milliseconds after the field is focused, and',
      'reading the page too early is why an agent decides there is nothing to click.',
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
      'you to do something they might want to see ("busca un tren", "resérvame esto", "hazlo',
      'tú"), and keep it for the rest of the task. Every result repeats whether the window',
      'is visible, so you can check instead of guessing. If it is headless and you want the',
      'user to see something, either reopen with visible: true or send a screenshot.',
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
      'action=exec_js runs your own JavaScript. Available in scope: `page` (a',
      'Playwright Page) and `state` (an object created in the sandbox that persists',
      'between calls in this chat, so use `state.x = ...` to remember something).',
      'Return a value and it comes back formatted. Do NOT touch `.constructor`,',
      '`__proto__` or `.prototype` on any object. Examples:',
      '  await page.getByRole("button", { name: "Enviar" }).click()',
      '  await page.fill("#search", "renfe madrid")',
      '  await page.waitForTimeout(500)',
      '  await page.evaluate(() => document.title)',
      'Never type credentials or card numbers into a page.',
    ].join('\n'),
    parameters: BrowserParams,
    // Sequential: the page is one shared object, and two actions in flight at once
    // race on the same navigation.
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const scope = scopeOf();
      const record = args as unknown as Record<string, unknown>;

      switch (args.action) {
        case 'open': {
          const url = String(record.url ?? '');
          if (!url) throw new Error('la acción open necesita una url');
          const info = await service.open(scope, url, { visible: Boolean(record.visible) });
          log.info('browser open', {
            host: info.url,
            status: info.status,
            retryFromRoot: info.retryFromRoot ?? false,
          });
          const body = [`Opened ${info.url}\nTitle: ${info.title}\nHTTP ${info.status ?? '?'}`];
          if (info.note) body.push(info.note);
          return {
            content: [{ type: 'text', text: `${body.join('\n')}${visibleNote(info.visible)}` }],
            details: info,
          };
        }

        case 'snapshot': {
          const text = await service.snapshot(scope);
          return {
            content: [
              { type: 'text', text: `${text}${visibleNote(windowVisible(service, scope))}` },
            ],
            details: { lines: text.split('\n').length, visible: windowVisible(service, scope) },
          };
        }

        case 'click': {
          const target = requireTarget(record);
          const result = await service.clickTarget(scope, target, {
            timeoutMs: readTimeout(record),
          });
          return {
            content: [
              {
                type: 'text',
                text: `${describeTarget(result, { done: 'clicked', missing: 'hacer clic en' })}${visibleNote(result.visible)}`,
              },
            ],
            details: { ...result },
          };
        }

        case 'fill': {
          const target = requireTarget(record);
          const value = String(record.text ?? '');
          if (!value) throw new Error('la acción fill necesita text');
          // Resolved first, and through the same rescue chain as click: a stale
          // selector used to be the end of the turn. The fill itself still goes through
          // the read-back script, which is what catches an autocomplete that mangles
          // what was typed.
          const resolved = await service.resolveTarget(scope, target, {
            timeoutMs: readTimeout(record),
          });
          if (!resolved.ok) {
            return {
              content: [
                {
                  type: 'text',
                  text: `${describeTarget(resolved, { done: 'filled', missing: 'encontrar el campo para escribir en' })}${visibleNote(resolved.visible)}`,
                },
              ],
              details: { ...resolved, value },
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
            details: { ...resolved, value, filled: text.text },
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
          return {
            content: [{ type: 'text', text: `${text.text}${visibleNote(resolved.visible)}` }],
            details: { ...resolved, key },
          };
        }

        case 'wait':
        case 'wait_for': {
          const { selector, text } = waitTarget(record);
          if (!selector && !text) {
            throw new Error(
              'la acción wait necesita with= (un selector o el texto que esperas), ' +
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

        case 'pick': {
          const label = String(record.with ?? record.text ?? '').trim();
          const from = String(record.from ?? record.selector ?? '').trim();
          if (!label) {
            throw new Error(
              'la acción pick necesita la etiqueta a elegir en with=, por ejemplo with="Madrid"',
            );
          }
          if (!from) {
            throw new Error(
              'la acción pick necesita el campo donde escribir en from=, por ejemplo from="#origen"',
            );
          }
          const result = await service.pick(scope, { label, from, timeoutMs: readTimeout(record) });
          log.info('browser pick', { label, from, ok: result.ok, chosen: result.chosen });
          return {
            content: [
              { type: 'text', text: `${describePick(result)}${visibleNote(result.visible)}` },
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

        case 'exec_js': {
          const code = String(record.code ?? '');
          if (!code.trim()) throw new Error('la accion exec_js necesita code');
          const result = await service.execJs(scope, code, {
            visible: Boolean(record.visible),
          });
          const content: Array<
            { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }
          > = [{ type: 'text', text: result.text || '(sin valor de retorno)' }];
          if (result.console.length) {
            content.push({ type: 'text', text: `console:\n${result.console.join('\n')}` });
          }
          // The script can hand back a screenshot by returning it: the escape hatch
          // has to cover "I need to see this" without a second round trip.
          const shot = extractScreenshot(result.text);
          if (shot) {
            content.push({ type: 'image', mimeType: 'image/png', data: shot });
          }
          if (result.timedOut)
            content.push({ type: 'text', text: '(el código excedió el tiempo)' });
          const visible = windowVisible(service, scope);
          return {
            content: [...content, { type: 'text', text: visibleNote(visible) }],
            details: { timedOut: result.timedOut, consoleLines: result.console.length, visible },
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

/** Text for a pick, including the options that were on screen when it did not match. */
function describePick(result: PickResult): string {
  const head = result.alreadySet
    ? `El campo ${result.field} ya decía "${result.value}". No he tocado nada.`
    : result.ok
      ? `Elegido "${result.chosen}" en ${result.field}. El campo quedó con "${result.value}" (${result.waitedMs}ms).`
      : `No he podido elegir "${result.label}" en ${result.field}. ${result.reason ?? ''}`;
  const options = result.options.length
    ? `\nSugerencias que sí aparecen: [${result.options.map((o) => `"${o}"`).join(', ')}]`
    : '';
  return `${head}${options}`;
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
