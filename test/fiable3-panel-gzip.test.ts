import { request } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { renderPage } from '../src/webui/page.js';
import { acceptsGzip, startWebUi, type WebUiDeps } from '../src/webui/server.js';

// La página del panel pesaba ~120 KB en cada carga (también desde el móvil por
// Tailscale), sin comprimir. Con gzip son ~30 KB y se comprime una sola vez.
const deps: WebUiDeps = {
  token: 't',
  status: () => ({}),
  sessions: () => [],
  memory: () => [],
  auditVerify: () => ({}),
};

function get(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>(
    (resolve, reject) => {
      const req = request(url, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      });
      req.on('error', reject);
      req.end();
    },
  );
}

describe('panel web comprimido', () => {
  it('con Accept-Encoding: gzip la página va comprimida (≥ 70 % menos) y es la misma', async () => {
    const ui = await startWebUi(deps);
    try {
      const gz = await get(`${ui.url}/`, { 'Accept-Encoding': 'gzip, deflate, br' });
      expect(gz.status).toBe(200);
      expect(gz.headers['content-encoding']).toBe('gzip');
      expect(gz.headers.vary).toMatch(/Accept-Encoding/);
      const html = renderPage();
      expect(gunzipSync(gz.body).toString('utf8')).toBe(html);
      expect(gz.body.length).toBeLessThan(Buffer.byteLength(html) * 0.3);
      expect(Number(gz.headers['content-length'])).toBe(gz.body.length);
      // Sin gzip, la de siempre.
      const plain = await get(`${ui.url}/`, {});
      expect(plain.headers['content-encoding']).toBeUndefined();
      expect(plain.body.toString('utf8')).toBe(html);
    } finally {
      await ui.close();
    }
  });

  it('lee bien Accept-Encoding', () => {
    expect(acceptsGzip('gzip')).toBe(true);
    expect(acceptsGzip('br, GZIP;q=0.8')).toBe(true);
    expect(acceptsGzip('*')).toBe(true);
    expect(acceptsGzip('gzip;q=0')).toBe(false);
    expect(acceptsGzip('br, deflate')).toBe(false);
    expect(acceptsGzip(undefined)).toBe(false);
    expect(acceptsGzip(['deflate', 'gzip'])).toBe(true);
  });
});
