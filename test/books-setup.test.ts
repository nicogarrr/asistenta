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
const flowCalls = {
  requestCode: 0,
  complete: 0,
  getFlow: 0,
  fresh: 0,
  verifySmtp: 0,
  saveMail: 0,
  smtpFails: false,
  failWith: '',
};

async function boot(): Promise<void> {
  // Aislamiento: cada boot empieza con contadores a cero y sin .env previo.
  flowCalls.requestCode = 0;
  flowCalls.complete = 0;
  flowCalls.getFlow = 0;
  flowCalls.fresh = 0;
  flowCalls.verifySmtp = 0;
  flowCalls.saveMail = 0;
  flowCalls.smtpFails = false;
  const { rmSync } = await import('node:fs');
  rmSync(process.env.BOOKS_ENV_PATH ?? '', { force: true });
  const fakeFlow = {
    requestCode: async () => {
      flowCalls.requestCode += 1;
    },
    complete: async () => {
      flowCalls.complete += 1;
      if (flowCalls.failWith) throw new Error(flowCalls.failWith);
    },
  };
  flowCalls.getFlow = 0;
  flowCalls.fresh = 0;
  flowCalls.verifySmtp = 0;
  flowCalls.saveMail = 0;
  const s: Server = createServer((req, res) => {
    // El handler necesita el puerto real: se crea tras listen.
    const handler = makeSetupHandler({
      getFlow: async (opts?: { fresh?: boolean }) => {
        flowCalls.getFlow += 1;
        if (opts?.fresh) flowCalls.fresh += 1;
        return fakeFlow;
      },
      token: TOKEN,
      port: (s.address() as AddressInfo).port,
      phone: '+34600000000',
      verifySmtp: async () => {
        flowCalls.verifySmtp += 1;
        if (flowCalls.smtpFails) throw new Error('535 auth failed');
      },
      saveMail: async () => {
        flowCalls.saveMail += 1;
      },
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
  it('GET no construye el LoginFlow: sin credenciales la pagina abre igual', async () => {
    await boot();
    const res = await raw(port, { path: `/?k=${TOKEN}` });
    expect(res.status).toBe(200);
    expect(flowCalls.getFlow).toBe(0);
  });

  it('un segundo /setup pide flow FRESCO (reconfiguracion no usa creds viejas)', async () => {
    await boot();
    const body = `api_id=12345&api_hash=${'a'.repeat(32)}`;
    await raw(port, { method: 'POST', path: `/setup?k=${TOKEN}`, body });
    await raw(port, { method: 'POST', path: `/setup?k=${TOKEN}`, body });
    expect(flowCalls.fresh).toBe(2);
  });

  it('app password con formato invalido: 400, sin verificar ni guardar', async () => {
    await boot();
    const res = await raw(port, {
      method: 'POST',
      path: `/gmail?k=${TOKEN}`,
      body: 'gmail_address=nico%40gmail.com&app_password=1234',
    });
    expect(res.status).toBe(400);
    expect(flowCalls.verifySmtp).toBe(0);
    expect(flowCalls.saveMail).toBe(0);
  });

  it('Google rechaza el login SMTP: 502 y NO se guarda nada', async () => {
    await boot();
    flowCalls.smtpFails = true;
    const res = await raw(port, {
      method: 'POST',
      path: `/gmail?k=${TOKEN}`,
      body: `gmail_address=nico%40gmail.com&app_password=${'a'.repeat(16)}`,
    });
    expect(res.status).toBe(502);
    expect(flowCalls.saveMail).toBe(0);
  });

  it('login SMTP valido: guarda la cuenta (16 letras con espacios admitidas)', async () => {
    await boot();
    const grouped = 'abcd efgh ijkl mnop';
    const res = await raw(port, {
      method: 'POST',
      path: `/gmail?k=${TOKEN}`,
      body: `gmail_address=nico%40gmail.com&app_password=${encodeURIComponent(grouped)}`,
    });
    expect(res.status).toBe(200);
    expect(flowCalls.verifySmtp).toBe(1);
    expect(flowCalls.saveMail).toBe(1);
  });

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
    // Ver test/books-userbot.test.ts: en Windows no hay bits POSIX, chmodSync
    // solo alterna read-only y stat.mode devuelve 0666 siempre.
    if (process.platform === 'win32') {
      expect(statSync(envPath).mode & 0o200).toBe(0o200);
    } else {
      expect(statSync(envPath).mode & 0o777).toBe(0o600);
    }
  });

  it('error de Telegram se escapa en el HTML (sin XSS)', async () => {
    await boot();
    flowCalls.failWith = '<script>alert(1)</script>';
    const res = await raw(port, { method: 'POST', path: `/login?k=${TOKEN}`, body: 'code=1' });
    expect(res.status).toBe(500);
    expect(res.body).not.toContain('<script>');
    expect(res.body).not.toContain('alert(1)');
  });

  it('un fallo de Telegram sale en castellano llano, sin «Error:» crudo', async () => {
    await boot();
    flowCalls.failWith = 'PHONE_CODE_INVALID';
    const bad = await raw(port, { method: 'POST', path: `/login?k=${TOKEN}`, body: 'code=1' });
    expect(bad.status).toBe(500);
    expect(bad.body).not.toMatch(/Error:|PHONE_CODE_INVALID/);
    expect(bad.body).toContain('El código no es válido o ha caducado');
    flowCalls.failWith = 'socket hang up';
    const other = await raw(port, { method: 'POST', path: `/login?k=${TOKEN}`, body: 'code=1' });
    expect(other.body).not.toMatch(/Error:|socket hang up/);
    expect(other.body).toContain('No se pudo completar este paso con Telegram');
  });
});
