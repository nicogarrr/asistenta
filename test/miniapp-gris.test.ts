import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { MINIAPP_TEXTOS, renderMiniAppScript } from '../src/webui/miniapp.js';
import { renderPage } from '../src/webui/page.js';
import { renderVozPage } from '../src/webui/voz-page.js';

/**
 * 6 nov (Nico): /panel → «📱 Abrir panel» en Telegram Android se quedaba gris para
 * siempre. La página no avisaba a Telegram (`web_app_ready`) y si la entrada con initData
 * fallaba no decía nada. Aquí se ejecuta el script de la Mini App con un Telegram falso.
 */
type Resp = { ok: boolean; status: number; body: unknown } | 'red';

async function abrir(resp: Resp, guardado = '') {
  const eventos: string[] = [];
  const aviso = { textContent: '', hidden: true };
  const replaced: string[] = [];
  const store = new Map<string, string>(guardado ? [['asistenta.webui.token', guardado]] : []);
  const window: Record<string, unknown> = {
    location: {
      hash: '#tgWebAppData=query_id%3D1%26hash%3Dabc&tgWebAppVersion=8.0',
      pathname: '/',
      replace: (u: string) => replaced.push(u),
    },
    TelegramWebviewProxy: { postEvent: (t: string) => eventos.push(t) },
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
  };
  window.parent = window;
  const ctx = {
    window,
    URLSearchParams,
    JSON,
    encodeURIComponent,
    document: { getElementById: (id: string) => (id === 'aviso' ? aviso : null) },
    fetch: async () => {
      if (resp === 'red') throw new TypeError('Failed to fetch');
      return { ok: resp.ok, status: resp.status, json: async () => resp.body };
    },
  };
  runInNewContext(renderMiniAppScript(), ctx);
  await new Promise((r) => setTimeout(r, 10));
  return { eventos, aviso, replaced, store };
}

describe('Mini App de Telegram: nunca gris', () => {
  it('avisa a Telegram de que está lista y entra con el token que da el PC', async () => {
    const r = await abrir({ ok: true, status: 200, body: { token: 'tok-1' } });
    expect(r.eventos).toEqual(['web_app_ready', 'web_app_expand']);
    expect(r.replaced).toEqual(['/?token=tok-1']);
    expect(r.store.get('asistenta.webui.token')).toBe('tok-1');
  });

  it('un token viejo guardado se renueva con initData', async () => {
    const r = await abrir({ ok: true, status: 200, body: { token: 'nuevo' } }, 'viejo');
    expect(r.replaced).toEqual(['/?token=nuevo']);
  });

  it('si Telegram no confirma que eres tú, lo dice en castellano', async () => {
    const r = await abrir({ ok: false, status: 401, body: { error: 'x' } });
    expect(r.aviso.hidden).toBe(false);
    expect(r.aviso.textContent).toBe(MINIAPP_TEXTOS.rechazo);
    expect(r.replaced).toEqual([]);
  });

  it('si el PC no tiene la Mini App activada, da el motivo', async () => {
    const r = await abrir({
      ok: false,
      status: 503,
      body: { error: 'La Mini App no está disponible' },
    });
    expect(r.aviso.textContent).toContain('La Mini App no está disponible');
  });

  it('sin conexión con el PC, pide encender Tailscale en el móvil', async () => {
    const r = await abrir('red');
    expect(r.aviso.textContent).toBe(MINIAPP_TEXTOS.sinRed);
  });

  it('el panel y /voz llevan el aviso web_app_ready', () => {
    expect(renderPage()).toContain("'web_app_ready'");
    expect(renderVozPage()).toContain("'web_app_ready'");
  });
});
