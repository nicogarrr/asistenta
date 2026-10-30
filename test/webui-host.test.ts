import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  hostAllowed,
  hostHeaderName,
  parseAllowedHosts,
  startWebUi,
  type WebUiDeps,
} from '../src/webui/server.js';

const TOKEN = 'token-de-prueba-host';
const deps: WebUiDeps = {
  token: TOKEN,
  status: () => ({ ok: true }),
  sessions: () => [],
  memory: () => ({}),
  auditVerify: () => ({ ok: true }),
};

let ui: Awaited<ReturnType<typeof startWebUi>>;
beforeAll(async () => {
  ui = await startWebUi(deps);
});
afterAll(async () => {
  await ui.close();
});

/** fetch no deja fijar Host a mano; node:http sí, como haría un navegador tras un DNS rebinding. */
function get(path: string, host: string | null, headers: Record<string, string> = {}) {
  const url = new URL(ui.url);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method: 'GET',
        setHost: host !== null,
        headers: host === null ? headers : { ...headers, Host: host },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('panel web: cabecera Host (DNS rebinding)', () => {
  it('sirve el panel por sus nombres locales', async () => {
    const port = new URL(ui.url).port;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, 'localhost', 'LOCALHOST.']) {
      expect((await get('/', host)).status).toBe(200);
    }
    const api = await get('/api/status', `127.0.0.1:${port}`, { Authorization: `Bearer ${TOKEN}` });
    expect(api.status).toBe(200);
  });

  it('rechaza un dominio ajeno que apunta a 127.0.0.1, también en la API con token', async () => {
    const page = await get('/', 'evil.example:80');
    expect(page.status).toBe(403);
    expect(page.body).not.toContain('<html');
    const api = await get('/api/status', 'evil.example', { Authorization: `Bearer ${TOKEN}` });
    expect(api.status).toBe(403);
    expect(api.body).toContain('Host no permitido');
  });

  it('rechaza el nombre de Tailscale y una petición sin Host', async () => {
    expect((await get('/', 'mi-pc.tail1234.ts.net')).status).toBe(403);
    expect((await get('/', '127.0.0.1.evil.example')).status).toBe(403);
    // Sin Host, node:http ya responde 400 antes de llegar al panel; en ningún caso 200.
    expect([400, 403]).toContain((await get('/', null)).status);
  });

  it('normaliza el nombre: puerto, IPv6 entre corchetes, mayúsculas y punto final', () => {
    expect(hostHeaderName('[::1]:8080')).toBe('[::1]');
    expect(hostHeaderName('LocalHost.:3000')).toBe('localhost');
    expect(hostHeaderName('[::1')).toBe('');
    expect(hostAllowed('127.0.0.2:9')).toBe(true);
    expect(hostAllowed('127.0.0.1.nip.io')).toBe(false);
    expect(hostAllowed(undefined)).toBe(false);
  });

  it('PA_WEB_ALLOWED_HOSTS añade nombres exactos, sin comodines', async () => {
    expect(parseAllowedHosts(' Mi-PC.tail1234.ts.net , *.ts.net,, otro.lan:8080 ')).toEqual([
      'mi-pc.tail1234.ts.net',
      'otro.lan',
    ]);
    expect(parseAllowedHosts(undefined)).toEqual([]);
    const extra = await startWebUi(deps, { allowedHosts: ['mi-pc.tail1234.ts.net'] });
    const url = new URL(extra.url);
    const call = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          { hostname: url.hostname, port: url.port, path: '/', headers: { Host: host } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
    try {
      expect(await call('mi-pc.tail1234.ts.net')).toBe(200);
      expect(await call('otro-pc.tail1234.ts.net')).toBe(403);
      expect(await call('evil.example')).toBe(403);
    } finally {
      await extra.close();
    }
  });
});
