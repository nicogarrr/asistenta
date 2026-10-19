import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALERT_INGEST_PATH,
  type AlertInbox,
  formatAlert,
  parseAlert,
  signAlert,
  startAlertInbox,
} from '../src/alerts/inbox.js';

const SECRET = 'test-secret-0123456789';
let inbox: AlertInbox | null = null;
afterEach(async () => {
  await inbox?.close();
  inbox = null;
});

async function start(send: (t: string) => Promise<boolean>, now?: () => number) {
  inbox = startAlertInbox({ port: 0, token: SECRET, send, now });
  if (!inbox) throw new Error('no arranco');
  await inbox.ready;
  return inbox;
}

function post(
  port: number,
  body: string,
  opts: { secret?: string; ts?: number; nonce?: string; path?: string; sig?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? randomBytes(8).toString('hex');
  const sig = opts.sig ?? signAlert(opts.secret ?? SECRET, ts, nonce, body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: opts.path ?? ALERT_INGEST_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-alert-ts': ts,
          'x-alert-nonce': nonce,
          'x-alert-sig': sig,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const alert = (id = 'a1') =>
  JSON.stringify({
    id,
    source: 'cavaai',
    severity: 'critical',
    title: 'Postgres caido',
    text: 'x',
  });

describe('alert inbox', () => {
  it('no arranca sin token (fail-closed)', () => {
    expect(startAlertInbox({ port: 0, token: '', send: async () => true })).toBeNull();
    expect(startAlertInbox({ port: 0, token: undefined, send: async () => true })).toBeNull();
  });

  it('entrega una alerta firmada como texto plano al dueno', async () => {
    const sent: string[] = [];
    const i = await start(async (t) => {
      sent.push(t);
      return true;
    });
    const r = await post(i.port, alert());
    expect(r.status).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('cavaai [critical] Postgres caido');
  });

  it('rechaza firma mala, secreto ajeno y cuerpo alterado, sin entregar nada', async () => {
    const sent: string[] = [];
    const i = await start(async (t) => {
      sent.push(t);
      return true;
    });
    expect((await post(i.port, alert(), { secret: 'otro-secreto-xxxxxxxxxx' })).status).toBe(401);
    expect((await post(i.port, alert(), { sig: 'a'.repeat(64) })).status).toBe(401);
    const ts = Math.floor(Date.now() / 1000);
    const sig = signAlert(SECRET, String(ts), 'abcdef0123456789', alert('a1'));
    const tampered = await post(i.port, alert('a2'), { ts, nonce: 'abcdef0123456789', sig });
    expect(tampered.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('rechaza firmas caducadas y replays', async () => {
    const sent: string[] = [];
    const i = await start(async (t) => {
      sent.push(t);
      return true;
    });
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect((await post(i.port, alert(), { ts: old })).status).toBe(401);
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'aaaaaaaabbbbbbbb';
    expect((await post(i.port, alert('r1'), { ts, nonce })).status).toBe(202);
    expect((await post(i.port, alert('r1'), { ts, nonce })).status).toBe(401);
    expect(sent).toHaveLength(1);
  });

  it('deduplica por id y reintenta si no hay chat del dueno', async () => {
    let ready = false;
    const sent: string[] = [];
    const i = await start(async (t) => {
      if (!ready) return false;
      sent.push(t);
      return true;
    });
    expect((await post(i.port, alert('d1'))).status).toBe(503);
    ready = true;
    expect((await post(i.port, alert('d1'))).status).toBe(202);
    const again = await post(i.port, alert('d1'));
    expect(again.status).toBe(200);
    expect(again.json.duplicate).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('limita la tasa y el tamano del cuerpo', async () => {
    const i = await start(async () => true);
    let last = 0;
    for (let n = 0; n < 31; n++) last = (await post(i.port, alert(`rate${n}`))).status;
    expect(last).toBe(429);
    const big = JSON.stringify({ id: 'big', title: 'x', text: 'y'.repeat(5000) });
    const r = await post(i.port, big).catch(() => ({ status: 413 }));
    expect(r.status).toBe(413);
  });

  it('solo rutas conocidas', async () => {
    const i = await start(async () => true);
    expect((await post(i.port, alert(), { path: '/otra' })).status).toBe(404);
  });
});

describe('parseAlert / formatAlert', () => {
  it('limpia caracteres de control y bidi, y no admite fuentes ajenas', () => {
    const r = parseAlert(
      { id: 'x1', title: 'a\u202eb\u0007c', text: 'l1\n\n\n\n\nl2', severity: 'warn' },
      ['cavaai'],
    );
    expect(r.ok && r.alert.title).toBe('abc');
    expect(r.ok && r.alert.text).toBe('l1\n\nl2');
    expect(parseAlert({ id: 'x', title: 't', source: 'evil' }, ['cavaai']).ok).toBe(false);
  });

  it('valida id, severidad y url', () => {
    const ok = (o: object) => parseAlert(o, ['cavaai']).ok;
    expect(ok({ id: 'bad id!', title: 't' })).toBe(false);
    expect(ok({ id: 'a', title: 't', severity: 'panic' })).toBe(false);
    expect(ok({ id: 'a', title: 't', url: 'javascript:alert(1)' })).toBe(false);
    expect(ok({ id: 'a', title: 't', url: 'https://cava.example/x' })).toBe(true);
    expect(ok({ id: 'a' })).toBe(false);
    expect(ok([])).toBe(false);
  });

  it('formatea en texto plano', () => {
    const r = parseAlert({ id: 'a', title: 'Disco al 95%', severity: 'warn' }, ['cavaai']);
    expect(r.ok && formatAlert(r.alert)).toBe('⚠️ cavaai [warn] Disco al 95%');
  });
});
