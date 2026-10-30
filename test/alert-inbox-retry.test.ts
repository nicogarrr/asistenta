import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALERT_HEALTH_PATH,
  ALERT_INGEST_PATH,
  type AlertInbox,
  signAlert,
  startAlertInbox,
} from '../src/alerts/inbox.js';

const SECRET = 'test-secret-0123456789';
let inbox: AlertInbox | null = null;
afterEach(async () => {
  await inbox?.close();
  inbox = null;
});

async function start(send: (t: string) => Promise<boolean>) {
  inbox = startAlertInbox({ port: 0, token: SECRET, send });
  if (!inbox) throw new Error('no arrancó');
  await inbox.ready;
  return inbox;
}

interface Signed {
  ts: string;
  nonce: string;
  sig: string;
}
const sign = (body: string): Signed => {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(8).toString('hex');
  return { ts, nonce, sig: signAlert(SECRET, ts, nonce, body) };
};

function send(
  port: number,
  body: string,
  opts: { signed?: Signed; method?: string; path?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const s = opts.signed ?? sign(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: opts.path ?? ALERT_INGEST_PATH,
        method: opts.method ?? 'POST',
        headers: {
          'content-type': 'application/json',
          'x-alert-ts': s.ts,
          'x-alert-nonce': s.nonce,
          'x-alert-sig': s.sig,
          ...opts.headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }),
        );
      },
    );
    req.on('error', reject);
    req.end(opts.method === 'GET' || opts.method === 'HEAD' ? undefined : body);
  });
}

const alert = (id: string) =>
  JSON.stringify({ id, source: 'cavaai', severity: 'warn', title: 'Disco al 90 %' });

describe('alert inbox: reintentos tras «reintenta»', () => {
  it('la MISMA petición firmada se puede repetir si no se entregó (antes: 401 por replay)', async () => {
    let ownerChat = false;
    const delivered: string[] = [];
    const i = await start(async (t) => {
      if (!ownerChat) return false;
      delivered.push(t);
      return true;
    });
    const body = alert('retry-1');
    const signed = sign(body);
    expect((await send(i.port, body, { signed })).status).toBe(503);
    ownerChat = true;
    expect((await send(i.port, body, { signed })).status).toBe(202);
    expect(delivered).toHaveLength(1);
    // Una vez entregada, la misma firma sí es un replay.
    expect((await send(i.port, body, { signed })).status).toBe(401);
  });

  it('si el envío lanza, el reintento idéntico también vale', async () => {
    let fail = true;
    const i = await start(async () => {
      if (fail) throw new Error('telegram caído');
      return true;
    });
    const body = alert('retry-2');
    const signed = sign(body);
    const first = await send(i.port, body, { signed });
    expect(first.status).toBe(503);
    expect(first.json?.error).toMatch(/reintenta/);
    fail = false;
    expect((await send(i.port, body, { signed })).status).toBe(202);
  });

  it('los 503 sin chat del dueño no gastan el cupo por minuto (antes: la primera real daba 429)', async () => {
    let ownerChat = false;
    const i = await start(async () => ownerChat);
    for (let n = 0; n < 35; n++) expect((await send(i.port, alert(`wait${n}`))).status).toBe(503);
    ownerChat = true;
    expect((await send(i.port, alert('real'))).status).toBe(202);
  });
});

describe('alert inbox: rutas, métodos y cuerpos', () => {
  it('health responde sin firma; GET en la ruta de ingesta es 405', async () => {
    const i = await start(async () => true);
    const health = await send(i.port, '', { method: 'GET', path: ALERT_HEALTH_PATH });
    expect(health).toEqual({ status: 200, json: { ok: true, service: 'alert-inbox' } });
    const slash = await send(i.port, '', { method: 'GET', path: `${ALERT_HEALTH_PATH}/?x=1` });
    expect(slash.status).toBe(200);
    expect((await send(i.port, '', { method: 'GET' })).status).toBe(405);
  });

  it('JSON roto o alerta inválida: 400 y nada entregado', async () => {
    const delivered: string[] = [];
    const i = await start(async (t) => {
      delivered.push(t);
      return true;
    });
    const broken = await send(i.port, '{"id":');
    expect(broken).toEqual({ status: 400, json: { ok: false, error: 'json' } });
    const noTitle = await send(i.port, JSON.stringify({ id: 'x1', source: 'cavaai' }));
    expect(noTitle).toEqual({ status: 400, json: { ok: false, error: 'title' } });
    expect(delivered).toEqual([]);
  });

  it('un content-length enorme se corta antes de leer nada', async () => {
    const i = await start(async () => true);
    const r = await send(i.port, alert('big'), { headers: { 'content-length': '999999' } }).catch(
      () => ({ status: 413, json: null }),
    );
    expect(r.status).toBe(413);
  });

  it('faltan cabeceras de firma o tienen otro formato: 401', async () => {
    const i = await start(async () => true);
    const body = alert('hdr');
    const good = sign(body);
    for (const signed of [
      { ...good, ts: 'ayer' },
      { ...good, nonce: 'NO-HEX' },
      { ...good, sig: 'corta' },
      { ...good, ts: String(Math.floor(Date.now() / 1000) - 3600) },
    ])
      expect((await send(i.port, body, { signed })).status).toBe(401);
  });
});
