import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { BrowserService } from '../browser/service.js';
import { log, logHost } from '../log.js';
import { isPaymentText } from '../permissions.js';

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
    Type.Literal('choose'),
    Type.Literal('press'),
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
        'CSS or text selector for click/fill/press. Prefer a test id, role or label ' +
        'selector over coordinates; there are no coordinates here on purpose.',
    }),
  ),
  text: Type.Optional(Type.String({ description: 'For fill and choose: the text to type.' })),
  option: Type.Optional(
    Type.String({
      description:
        'For choose: the suggestion to pick, if not just the typed text (e.g. "Madrid Chamartín"). Needed when several suggestions match.',
    }),
  ),
  key: Type.Optional(Type.String({ description: 'For press, e.g. "Enter".' })),
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
        'For open and exec_js. Put the window on screen instead of headless. REQUIRED ' +
        'for any media: a headless browser has no audio output, so a video "plays" in ' +
        'silence and you would be lying if you said the user can hear it.',
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
  const sel = JSON.stringify(selector);
  const val = JSON.stringify(value);
  return `const loc = page.locator(${sel}).first();
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
  return 'ATENCIÓN: el campo ' + ${sel} + ' quedó con "' + got + '" en lugar de "' + want + '". Revisa el autocompletado antes de continuar.';
}
return 'filled ' + ${sel} + (retried ? ' (reintentado tras limpiar el campo)' : '');`;
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
      '1. action=open with the url.',
      '2. action=snapshot to list the interactive elements and their selectors.',
      '3. action=click / fill / press with a selector from that snapshot.',
      '   For autocomplete / combobox fields (stations, cities, addresses) use',
      '   action=choose with selector + text (+ option to pick one of several): it types,',
      '   reads the suggestions, picks one by text and reads the field back.',
      '4. action=screenshot only when you need to see something a selector cannot',
      '   express (canvas, a video, a rendered image, an unexpected layout).',
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
    // Read by the agent before the permission gate runs: the page's own words about the
    // element the model is about to act on.
    gateHint: async (args: Record<string, unknown>) => {
      const action = String(args.action ?? '');
      const selector = typeof args.selector === 'string' ? args.selector : '';
      if (!selector || !['click', 'fill', 'press', 'choose'].includes(action)) return '';
      const target = await service.describeTarget(scopeOf(), selector);
      // Only for targets that read like money: the confirmation shows what is being paid.
      if (!isPaymentText(target)) return target;
      const summary = await service.summarisePage(scopeOf()).catch(() => '');
      return summary ? `${target}\nRESUMEN DE LA PÁGINA:\n${summary}` : target;
    },
    execute: async (_id, args) => {
      const scope = scopeOf();
      const record = args as unknown as Record<string, unknown>;

      switch (args.action) {
        case 'open': {
          const url = String(record.url ?? '');
          if (!url) throw new Error('la acción open necesita una url');
          const info = await service.open(scope, url, { visible: Boolean(record.visible) });
          log.info('browser open', { host: logHost(info.url), status: info.status });
          const note = await challengeNote(service, scope, sendImage);
          return {
            content: [
              {
                type: 'text',
                text: `${note ? `${note.text}\n` : ''}Opened ${info.url}\nTitle: ${info.title}\nHTTP ${info.status ?? '?'}`,
              },
            ],
            details: note ? { ...info, captcha: note.kind } : info,
          };
        }

        case 'snapshot': {
          const text = await service.snapshot(scope);
          const note = await challengeNote(service, scope, sendImage);
          return {
            content: [{ type: 'text', text: note ? `${note.text}\n${text}` : text }],
            details: { lines: text.split('\n').length, ...(note ? { captcha: note.kind } : {}) },
          };
        }

        case 'click': {
          const selector = requireSelector(record);
          const text = await service.execJs(
            scope,
            `await page.locator(${JSON.stringify(selector)}).first().click();
return 'clicked ' + ${JSON.stringify(selector)};`,
          );
          const note = await challengeNote(service, scope, sendImage);
          return {
            content: [{ type: 'text', text: note ? `${text.text}\n${note.text}` : text.text }],
            details: { selector, ...(note ? { captcha: note.kind } : {}) },
          };
        }

        case 'fill': {
          const selector = requireSelector(record);
          const value = String(record.text ?? '');
          if (!value) throw new Error('la acción fill necesita text');
          const text = await service.execJs(scope, buildFillScript(selector, value));
          return { content: [{ type: 'text', text: text.text }], details: { selector } };
        }

        // Autocomplete / combobox fields (stations, cities, addresses): types, reads the
        // suggestions, picks one by text and reads the field back. Works on any page.
        case 'choose': {
          const selector = requireSelector(record);
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
          const selector = requireSelector(record);
          const key = String(record.key ?? 'Enter');
          const text = await service.execJs(
            scope,
            `await page.locator(${JSON.stringify(selector)}).first().press(${JSON.stringify(key)});
return 'pressed ' + ${JSON.stringify(key)} + ' on ' + ${JSON.stringify(selector)};`,
          );
          const note = await challengeNote(service, scope, sendImage);
          return {
            content: [{ type: 'text', text: note ? `${text.text}\n${note.text}` : text.text }],
            details: { selector, key, ...(note ? { captcha: note.kind } : {}) },
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
          return {
            content: [
              {
                type: 'text',
                text: `Screenshot of the current page${record.fullPage ? ' (full page)' : ''}.${delivery}`,
              },
              { type: 'image', mimeType: shot.mimeType, data: shot.data },
            ],
            details: { fullPage: Boolean(record.fullPage), sent: delivery.includes('Enviada') },
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
          return {
            content,
            details: { timedOut: result.timedOut, consoleLines: result.console.length },
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
              details: { ...state, autoSkipped: auto.skipped, autoPolls: auto.polls },
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
              details: result,
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
            content: [{ type: 'text', text: result.text || '(sin datos)' }],
            details: { what, timedOut: result.timedOut },
          };
        }

        case 'back': {
          const info = await service.back(scope);
          return {
            content: [{ type: 'text', text: `Now at ${info.url}\nTitle: ${info.title}` }],
            details: info,
          };
        }

        case 'close': {
          await service.close(scope);
          return {
            content: [{ type: 'text', text: 'Browser closed. The profile is kept on disk.' }],
            details: {},
          };
        }

        default:
          throw new Error(`acción desconocida: ${String(args.action)}`);
      }
    },
  };
}

function requireSelector(record: Record<string, unknown>): string {
  const selector = String(record.selector ?? '');
  if (!selector.trim()) {
    throw new Error('esta acción necesita un selector (usa action=snapshot para verlos)');
  }
  return selector;
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
