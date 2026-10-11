import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

process.env.BOOKS_ENV_PATH = join(mkdtempSync(join(tmpdir(), 'books-setup-')), '.env');
process.env.BOOKS_TG_API_ID = '12345';
process.env.BOOKS_TG_API_HASH = 'a'.repeat(32);

const { escapeHtml, makeSetupHandler, validCredentialFormats } = await import(
  '../src/books/setup-page.js'
);

const TOKEN = 'test-token';

interface RawReply {
  status: number;
  body: string;
}

function raw(
  port: number,
  opts: { method?: string; path?: string; host?: string; origin?: string; body?: string },
): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}` };
    if (opts.origin) headers.origin = opts.origin;
    if (opts.body) headers['content-type'] = 'application/x-www-form-urlencoded';
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

let server: Server | undefined;
let port = 0;
const flowCalls = { requestCode: 0, complete: 0, failWith: '' };

async function boot(): Promise<void> {
  const fakeFlow = {
    requestCode: async () => {
      flowCalls.requestCode += 1;
    },
    complete: async () => {
      flowCalls.complete += 1;
      if (flowCalls.failWith) throw new Error(flowCalls.failWith);
    },
  };
  const s: Server = createServer((req, res) => {
    // El handler necesita el puerto real: se crea tras listen.
    const handler = makeSetupHandler({
      flow: fakeFlow,
      token: TOKEN,
      port: (s.address() as AddressInfo).port,
      phone: '+34600000000',
    });
    handler(req, res);
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  server = s;
  port = (s.address() as AddressInfo).port;
}

afterEach(async () => {
  flowCalls.failWith = '';
  if (server) await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

describe('escapeHtml', () => {
  it('escapa markup y comillas', () => {
    expect(escapeHtml('<img src=x onerror="y">')).toBe('&lt;img src=x onerror=&quot;y&quot;&gt;');
  });
});

describe('validCredentialFormats', () => {
  it('api_id numerico y api_hash hex-32; sin inyeccion de lineas', () => {
    expect(validCredentialFormats('12345', 'a'.repeat(32))).toBe(true);
    expect(validCredentialFormats('abc', 'a'.repeat(32))).toBe(false);
    expect(validCredentialFormats('12345', 'zz'.repeat(16))).toBe(false);
    expect(validCredentialFormats(`12345\nOTRA=1`, 'a'.repeat(32))).toBe(false);
    expect(validCredentialFormats('12345', `aaaa\nX=1`)).toBe(false);
  });
});

describe('setup server (adversarial)', () => {
  it('GET sin token: 403', async () => {
    await boot();
    expect((await raw(port, {})).status).toBe(403);
  });

  it('token correcto pero Host ajeno: 403 (DNS rebinding)', async () => {
    await boot();
    const res = await raw(port, { path: `/?k=${TOKEN}`, host: 'evil.example' });
    expect(res.status).toBe(403);
  });

  it('token correcto pero Origin ajeno: 403 (CSRF desde otra web)', async () => {
    await boot();
    const res = await raw(port, {
      method: 'POST',
      path: `/setup?k=${TOKEN}`,
      origin: 'https://evil.example',
      body: `api_id=12345&api_hash=${'a'.repeat(32)}`,
    });
    expect(res.status).toBe(403);
    expect(flowCalls.requestCode).toBe(0);
  });

  it('POST con api_id inyectable: 400 y no escribe .env', async () => {
    await boot();
    const res = await raw(port, {
      method: 'POST',
      path: `/setup?k=${TOKEN}`,
      body: `api_id=123%0AHACK%3D1&api_hash=${'a'.repeat(32)}`,
    });
    expect(res.status).toBe(400);
    expect(() => statSync(process.env.BOOKS_ENV_PATH ?? '/nonexistent-x')).toThrow();
  });

  it('POST valido: pide codigo y escribe .env con 0600', async () => {
    await boot();
    const res = await raw(port, {
      method: 'POST',
      path: `/setup?k=${TOKEN}`,
      body: `api_id=12345&api_hash=${'a'.repeat(32)}`,
    });
    expect(res.status).toBe(200);
    expect(flowCalls.requestCode).toBe(1);
    const envPath = process.env.BOOKS_ENV_PATH ?? '';
    expect(envPath).not.toBe('');
    expect(readFileSync(envPath, 'utf8')).toContain('BOOKS_TG_API_ID=12345');
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('error de Telegram se escapa en el HTML (sin XSS)', async () => {
    await boot();
    flowCalls.failWith = '<script>alert(1)</script>';
    const res = await raw(port, { method: 'POST', path: `/login?k=${TOKEN}`, body: 'code=1' });
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('<script>');
    expect(res.body).toContain('&lt;script&gt;');
  });
});
