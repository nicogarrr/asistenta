/**
 * Mini App de Telegram: el panel se abre con un toque desde el chat (botón /panel o /voz)
 * y entra sin pegar el token. Telegram abre la página con `#tgWebAppData=<initData>`;
 * la página lo manda a /api/miniapp y aquí se comprueba la firma con el token del bot
 * (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
 * clave = HMAC-SHA256("WebAppData", token del bot); hash = HMAC-SHA256(clave, datos
 * ordenados «k=v» separados por saltos de línea, sin `hash`). Solo vale si el usuario
 * firmado es el dueño y la firma tiene menos de un día. Sin token del bot o sin dueño
 * configurado, siempre es no.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const MINIAPP_MAX_AGE_S = 24 * 3600;

export function signInitData(fields: Record<string, string>, botToken: string): string {
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const check = Object.keys(fields)
    .filter((k) => k !== 'hash')
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  return createHmac('sha256', secret).update(check).digest('hex');
}

/**
 * ¿`initData` (la query string que manda Telegram) está firmada por este bot, es del
 * dueño y es reciente? `now` en milisegundos.
 */
export function verifyInitData(
  initData: string,
  botToken: string | undefined,
  ownerId: number | string | null | undefined,
  now: number = Date.now(),
  maxAgeS: number = MINIAPP_MAX_AGE_S,
): boolean {
  if (!botToken || ownerId === null || ownerId === undefined || String(ownerId) === '')
    return false;
  if (typeof initData !== 'string' || initData.length === 0 || initData.length > 4096) return false;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash') ?? '';
  if (!/^[0-9a-f]{64}$/.test(hash)) return false;
  const fields: Record<string, string> = {};
  for (const [k, v] of params) if (k !== 'hash') fields[k] = v;
  const expected = Buffer.from(signInitData(fields, botToken), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return false;
  const authDate = Number(fields.auth_date);
  if (!Number.isFinite(authDate) || Math.abs(now / 1000 - authDate) > maxAgeS) return false;
  let user: unknown;
  try {
    user = JSON.parse(fields.user ?? '');
  } catch {
    return false;
  }
  const id = (user as { id?: unknown } | null)?.id;
  return id !== undefined && String(id) === String(ownerId);
}

/**
 * Aviso a Telegram de que la página ya está pintada (`web_app_ready`) y que ocupe la
 * pantalla entera (`web_app_expand`). Sin esto Telegram deja su pantalla gris de carga
 * hasta que el WebView da la página por cargada del todo, y en Android eso puede no
 * llegar nunca (6 nov: «se queda en gris cargando»). No carga telegram-web-app.js (la CSP
 * no deja scripts de fuera): habla con el puente nativo igual que lo hace ese script.
 */
export function renderMiniAppReadyScript(): string {
  return `(function () {
  'use strict';
  var datos = new URLSearchParams((window.location.hash || '').slice(1)).get('tgWebAppData');
  if (!datos) return;
  function evento(tipo) {
    try {
      if (window.TelegramWebviewProxy && typeof window.TelegramWebviewProxy.postEvent === 'function') {
        window.TelegramWebviewProxy.postEvent(tipo, '');
      } else if (window.external && typeof window.external.notify === 'function') {
        window.external.notify(JSON.stringify({ eventType: tipo, eventData: '' }));
      } else if (window.parent && window.parent !== window) {
        window.parent.postMessage(JSON.stringify({ eventType: tipo, eventData: '' }), '*');
      }
    } catch (error) {}
  }
  evento('web_app_ready');
  evento('web_app_expand');
})();`;
}

/** Textos de la Mini App cuando no consigue entrar (siempre algo legible, nunca gris). */
export const MINIAPP_TEXTOS = {
  entrando: 'Entrando con Telegram…',
  sinRed:
    'No llego al PC desde el móvil. Enciende Tailscale en el móvil (que diga «Conectado») y vuelve a abrir el panel.',
  rechazo:
    'Telegram no ha confirmado que seas tú. Ábrelo desde tu chat con el bot (/panel) o pega abajo el token del panel.',
} as const;

/**
 * Entrada desde Telegram en el panel: manda `initData` a /api/miniapp y, con el token que
 * devuelve, recarga el panel ya dentro. Si falla, lo dice en castellano en #aviso (con el
 * motivo que da el PC) en vez de dejar la pantalla vacía. Va siempre que haya `initData`,
 * aunque haya un token guardado: uno viejo (PA_WEB_TOKEN cambiado) se renueva solo.
 */
export function renderMiniAppScript(): string {
  const t = JSON.stringify(MINIAPP_TEXTOS);
  return `${renderMiniAppReadyScript()}
(function () {
  'use strict';
  var TEXTOS = ${t};
  var CLAVE = 'asistenta.webui.token';
  var datos = new URLSearchParams((window.location.hash || '').slice(1)).get('tgWebAppData');
  if (!datos) return;
  function aviso(texto) {
    var a = document.getElementById('aviso');
    if (!a) return;
    a.textContent = texto;
    a.hidden = !texto;
  }
  var guardado = '';
  try { guardado = (window.localStorage.getItem(CLAVE) || '').trim(); } catch (error) {}
  if (!guardado) aviso(TEXTOS.entrando);
  fetch('/api/miniapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: datos })
  })
    .then(function (r) {
      return r.json().catch(function () { return null; }).then(function (d) {
        return { ok: r.ok, status: r.status, d: d };
      });
    })
    .then(function (x) {
      var nuevo = x.ok && x.d && typeof x.d.token === 'string' ? x.d.token : '';
      if (nuevo) {
        try { window.localStorage.setItem(CLAVE, nuevo); } catch (error) {}
        if (nuevo !== guardado) {
          window.location.replace(window.location.pathname + '?token=' + encodeURIComponent(nuevo));
        }
        return;
      }
      var motivo = x.d && typeof x.d.error === 'string' && x.d.error ? x.d.error : '';
      if (x.status === 401) aviso(TEXTOS.rechazo);
      else aviso('No he podido entrar con Telegram' + (motivo ? ': ' + motivo : ' (error ' + x.status + ').') + ' Puedes pegar abajo el token del panel.');
    }, function () {
      aviso(TEXTOS.sinRed);
    });
})();`;
}
