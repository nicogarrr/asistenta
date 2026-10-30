import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const servers: Server[] = [];
vi.mock('node:http', async (orig) => {
  const m = await orig<typeof import('node:http')>();
  return {
    ...m,
    createServer: ((...a: Parameters<typeof m.createServer>) => {
      const s = m.createServer(...a);
      servers.push(s);
      return s;
    }) as typeof m.createServer,
  };
});
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const { serveFileToHost } = await import('../src/audio/lan-server.js');

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-lan-cierre-'));
  servers.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function get(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

describe('servidor LAN de la tele: error tras abrir', () => {
  it('un error del servidor ya abierto lo cierra, borra el audio y no tumba el daemon', async () => {
    const file = join(dir, 'a.mp3');
    writeFileSync(file, '0123456789');
    const s = await serveFileToHost({ file, bindIp: '127.0.0.1', allowIp: '127.0.0.1' });
    const srv = servers[0];
    expect(srv).toBeDefined();
    // Dos errores seguidos: el segundo, sin listener, era una excepción no capturada.
    expect(() => {
      srv?.emit('error', new Error('fallo de red'));
      srv?.emit('error', new Error('otro fallo'));
    }).not.toThrow();
    expect(await within(s.closed, 2000)).not.toBe('timeout');
    expect(srv?.listening).toBe(false);
    expect(existsSync(file)).toBe(false);
  });
});

describe('servidor LAN de la tele: cabeceras Range raras', () => {
  it('varios rangos o otra unidad se ignoran y se sirve el fichero entero (200)', async () => {
    const file = join(dir, 'b.mp3');
    writeFileSync(file, '0123456789');
    const s = await serveFileToHost({ file, bindIp: '127.0.0.1', allowIp: '127.0.0.1' });
    for (const range of ['bytes=0-1,4-5', 'items=0-3']) {
      const r = await get(s.url, { Range: range });
      expect(r.status, range).toBe(200);
      expect(r.body, range).toBe('0123456789');
    }
    // Lo que sí se entiende sigue igual: un rango (206) y uno que no cabe (416).
    expect((await get(s.url, { Range: 'bytes=2-4' })).body).toBe('234');
    expect((await get(s.url, { Range: 'bytes=50-60' })).status).toBe(416);
    s.close();
    await s.closed;
  });
});
