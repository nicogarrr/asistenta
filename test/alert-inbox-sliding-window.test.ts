import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
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

let clock = Date.now();
async function start(send: (t: string) => Promise<boolean>) {
  inbox = startAlertInbox({ port: 0, token: SECRET, send, now: () => clock });
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
  const ts = String(Math.floor(clock / 1000));
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
  JSON.stringify({ id, source: 'cavaai', severity: 'warn', title: `Disco ${id}` });

describe('alert inbox: límite de 30 por minuto con ventana deslizante', () => {
  it('30 alertas a los 59 s y otras 30 a los 61 s: la segunda tanda espera (antes pasaban 60)', async () => {
    const base = Date.now();
    clock = base;
    let delivered = 0;
    const i = await start(async () => {
      delivered++;
      return true;
    });
    clock = base + 59_000;
    for (let n = 0; n < 30; n++) expect((await send(i.port, alert(`a${n}`))).status).toBe(202);
    clock = base + 61_000;
    expect((await send(i.port, alert('b0'))).status).toBe(429);
    // A minute after the first burst the quota is back.
    clock = base + 119_001;
    expect((await send(i.port, alert('b1'))).status).toBe(202);
    expect(delivered).toBe(31);
  });

  it('una alerta no entregada no gasta cupo', async () => {
    const base = Date.now();
    clock = base;
    let open = false;
    const i = await start(async () => open);
    for (let n = 0; n < 30; n++) expect((await send(i.port, alert(`c${n}`))).status).toBe(503);
    open = true;
    expect((await send(i.port, alert('d0'))).status).toBe(202);
  });
});
