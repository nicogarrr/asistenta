// El deduplicado del buzón de alertas: por fuente+id y persistente entre reinicios.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ALERT_INGEST_PATH,
  type AlertInbox,
  signAlert,
  startAlertInbox,
} from '../src/alerts/inbox.js';

const SECRET = 'test-secret-0123456789';
const open: AlertInbox[] = [];
afterEach(async () => {
  for (const i of open.splice(0)) await i.close();
});

async function start(send: (t: string) => Promise<boolean>, dedupeFile?: string) {
  const inbox = startAlertInbox({
    port: 0,
    token: SECRET,
    send,
    sources: ['cavaai', 'nas'],
    dedupeFile,
  });
  if (!inbox) throw new Error('no arranco');
  open.push(inbox);
  await inbox.ready;
  return inbox;
}

function post(
  port: number,
  body: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(8).toString('hex');
  const sig = signAlert(SECRET, ts, nonce, body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: ALERT_INGEST_PATH,
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

const alert = (id: string, source = 'cavaai') =>
  JSON.stringify({ id, source, severity: 'warn', title: 'Disco al 90%' });

describe('buzón de alertas: deduplicado', () => {
  it('el mismo id en dos fuentes distintas son dos alertas y llegan las dos', async () => {
    const sent: string[] = [];
    const inbox = await start(async (t) => {
      sent.push(t);
      return true;
    });
    expect((await post(inbox.port, alert('a1', 'cavaai'))).status).toBe(202);
    expect((await post(inbox.port, alert('a1', 'nas'))).status).toBe(202);
    expect(sent).toHaveLength(2);
  });

  it('un reintento del emisor tras reiniciar el daemon no se entrega dos veces', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-alerts-'));
    const file = join(dir, 'state', 'alerts-seen.json');
    const sent: string[] = [];
    const send = async (t: string) => {
      sent.push(t);
      return true;
    };
    const first = await start(send, file);
    expect((await post(first.port, alert('backup-ko'))).status).toBe(202);
    await first.close();
    open.splice(open.indexOf(first), 1);
    expect(existsSync(file)).toBe(true);

    const second = await start(send, file);
    const again = await post(second.port, alert('backup-ko'));
    expect(again.status).toBe(200);
    expect(again.json.duplicate).toBe(true);
    expect(sent).toHaveLength(1);
    // Otra alerta sí pasa.
    expect((await post(second.port, alert('otra'))).status).toBe(202);
    expect(sent).toHaveLength(2);
  });

  it('un fichero corrupto o caducado no impide arrancar ni entregar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-alerts-'));
    const file = join(dir, 'alerts-seen.json');
    writeFileSync(file, '{no es json');
    const sent: string[] = [];
    const inbox = await start(async (t) => {
      sent.push(t);
      return true;
    }, file);
    expect((await post(inbox.port, alert('x1'))).status).toBe(202);
    writeFileSync(file, JSON.stringify({ 'cavaai:viejo': 1 }));
    const inbox2 = await start(async (t) => {
      sent.push(t);
      return true;
    }, file);
    expect((await post(inbox2.port, alert('viejo'))).status).toBe(202);
    expect(sent).toHaveLength(2);
  });
});
