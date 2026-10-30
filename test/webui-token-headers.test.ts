import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

/**
 * El token del panel viaja una vez en `?token=` y la página nunca debe devolverlo
 * ni dejar que salga: ni incrustado en el HTML, ni por Referer, ni cargando nada
 * de fuera. Estas cabeceras eran el único freno y ningún test las fijaba
 * (core-dx-4).
 */
const TOKEN = 'secreto-panel-9f3c2a';

const deps: WebUiDeps = {
  token: TOKEN,
  status: () => ({ ok: true }),
  sessions: () => [],
  memory: () => [],
  auditVerify: () => ({ ok: true }),
  chat: async (text) => ({ text }),
  approvals: () => [],
  approve: async () => {},
};

let ui: Awaited<ReturnType<typeof startWebUi>>;
beforeAll(async () => {
  ui = await startWebUi(deps);
});
afterAll(async () => {
  await ui.close();
});

const get = (path: string, token?: string): Promise<Response> =>
  fetch(new URL(path, ui.url), token ? { headers: { Authorization: `Bearer ${token}` } } : {});

describe('panel: el token nunca sale de la página', () => {
  it('el HTML pedido con ?token= no contiene el token', async () => {
    const res = await get(`/?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain(encodeURIComponent(TOKEN));
  });

  it('la página no carga nada de otro origen', async () => {
    const html = await (await get('/')).text();
    expect(html).not.toMatch(/(?:src|href|action)\s*=\s*["']?(?:https?:)?\/\//i);
    expect(html).not.toMatch(/@import\s+url\(\s*["']?(?:https?:)?\/\//i);
  });

  it('CSP estricta: nada externo, sin marcos, sin <base>, sin envío de formularios', async () => {
    const res = await get('/');
    const csp = res.headers.get('content-security-policy') ?? '';
    const dir = new Map(
      csp
        .split(';')
        .map((d) => d.trim().split(/\s+/))
        .filter((p) => p[0])
        .map((p) => [p[0] as string, p.slice(1)]),
    );
    expect(dir.get('default-src')).toEqual(["'none'"]);
    expect(dir.get('frame-ancestors')).toEqual(["'none'"]);
    expect(dir.get('base-uri')).toEqual(["'none'"]);
    expect(dir.get('form-action')).toEqual(["'none'"]);
    expect(dir.get('connect-src')).toEqual(["'self'"]);
    for (const [, sources] of dir) {
      for (const s of sources) expect(s).not.toMatch(/^(?:https?:|\*|[a-z0-9.-]+\.[a-z]{2,})/i);
    }
  });

  it('sin Referer, sin sniffing, sin marcos y sin caché para la página', async () => {
    const res = await get('/');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('la API exige el Bearer exacto y no acepta el token por la URL', async () => {
    expect((await get('/api/status')).status).toBe(401);
    expect((await get(`/api/status?token=${TOKEN}`)).status).toBe(401);
    expect((await get('/api/status', `${TOKEN}x`)).status).toBe(401);
    expect((await get('/api/status', TOKEN.slice(0, -1))).status).toBe(401);
    const ok = await get('/api/status', TOKEN);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('referrer-policy')).toBe('no-referrer');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('una respuesta 401 no repite el token recibido', async () => {
    const res = await get('/api/status', 'otro-token-que-no-vale');
    expect(await res.text()).not.toContain('otro-token-que-no-vale');
  });
});
