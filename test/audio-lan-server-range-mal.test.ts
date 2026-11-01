import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serveFileToHost } from '../src/audio/lan-server.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

// RFC 9110 §14.2: una cabecera Range mal formada se ignora y se sirve el fichero
// entero (200). 416 queda solo para un rango bien escrito que no cabe en el fichero.
let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-lan-range-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function get(url: string, range: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    httpGet(url, { headers: { Range: range } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

describe('servidor LAN de la tele: Range mal formado', () => {
  it('un rango ilegible o al revés se ignora y se sirve el fichero entero (200)', async () => {
    const file = join(dir, 'n.mp3');
    writeFileSync(file, '0123456789');
    const s = await serveFileToHost({ file, bindIp: '127.0.0.1', allowIp: '127.0.0.1' });
    for (const range of ['bytes=5-3', 'bytes=abc', 'bytes=-', 'bytes=1-2-3', 'bytes= x']) {
      const r = await get(s.url, range);
      expect(r.status, range).toBe(200);
      expect(r.body, range).toBe('0123456789');
    }
    s.close();
    await s.closed;
  });

  it('un rango bien escrito sigue igual: 206 si cabe, 416 si no cabe', async () => {
    const file = join(dir, 'm.mp3');
    writeFileSync(file, '0123456789');
    const s = await serveFileToHost({ file, bindIp: '127.0.0.1', allowIp: '127.0.0.1' });
    expect(await get(s.url, 'bytes=2-4')).toEqual({ status: 206, body: '234' });
    expect(await get(s.url, 'bytes=-3')).toEqual({ status: 206, body: '789' });
    expect(await get(s.url, 'bytes=8-')).toEqual({ status: 206, body: '89' });
    expect(await get(s.url, 'bytes=3-3')).toEqual({ status: 206, body: '3' });
    expect((await get(s.url, 'bytes=50-60')).status).toBe(416);
    expect((await get(s.url, 'bytes=10-')).status).toBe(416);
    expect((await get(s.url, 'bytes=-0')).status).toBe(416);
    s.close();
    await s.closed;
  });
});
