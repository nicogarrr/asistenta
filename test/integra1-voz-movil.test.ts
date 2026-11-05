import { afterEach, describe, expect, it } from 'vitest';
import { type TailscaleRun, tailscaleCommand } from '../src/tailscale.js';
import { startWebUi } from '../src/webui/server.js';

const TOKEN = 'v'.repeat(32);
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function panel(extra: Record<string, unknown>) {
  const web = await startWebUi({
    token: TOKEN,
    status: () => ({}),
    sessions: () => [],
    memory: () => [],
    auditVerify: () => ({}),
    ...extra,
  });
  close = web.close;
  return web.url;
}

const nota = (url: string, body: Buffer, type = 'audio/webm', auth = `Bearer ${TOKEN}`) =>
  fetch(`${url}/api/voz`, {
    method: 'POST',
    headers: { 'Content-Type': type, Authorization: auth },
    body: new Uint8Array(body),
  });

describe('/voz: hablar con Asistenta desde el móvil', () => {
  it('transcribe la nota, responde el hilo principal y devuelve lo oído y la respuesta', async () => {
    const vistos: Array<{ n: number; mime: string }> = [];
    const chats: string[] = [];
    const url = await panel({
      transcribe: async (a: Buffer, mime: string) => {
        vistos.push({ n: a.length, mime });
        return ' ¿qué tengo hoy? ';
      },
      chat: async (t: string) => {
        chats.push(t);
        return { text: 'A las 10, dentista.' };
      },
    });
    const r = await nota(url, Buffer.alloc(3000, 1), 'audio/mp4;codecs=mp4a');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ oido: '¿qué tengo hoy?', text: 'A las 10, dentista.' });
    expect(vistos).toEqual([{ n: 3000, mime: 'audio/mp4' }]);
    expect(chats).toEqual(['¿qué tengo hoy?']);
  });

  it('sin token no pasa; si no se entiende, no molesta al modelo', async () => {
    let llamadas = 0;
    const url = await panel({
      transcribe: async () => '',
      chat: async () => {
        llamadas++;
        return { text: 'x' };
      },
    });
    expect((await nota(url, Buffer.alloc(10), 'audio/webm', 'Bearer malo')).status).toBe(401);
    const r = await nota(url, Buffer.alloc(10));
    expect((await r.json()).text).toContain('No te he entendido');
    expect(llamadas).toBe(0);
    expect((await nota(url, Buffer.alloc(10), 'text/plain')).status).toBe(415);
  });

  it('sin voz configurada responde 503 en castellano', async () => {
    const url = await panel({});
    const r = await nota(url, Buffer.alloc(10));
    expect(r.status).toBe(503);
    expect((await r.json()).error).toContain('voz');
  });

  it('la página /voz se sirve con CSP y graba con MediaRecorder', async () => {
    const url = await panel({});
    const r = await fetch(`${url}/voz`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toContain("connect-src 'self'");
    const html = await r.text();
    expect(html).toContain('MediaRecorder');
    expect(html).toContain('/api/miniapp');
    expect(html).toContain('Manos libres');
  });

  it('/voz en Telegram da el botón de Mini App a /voz', async () => {
    const run: TailscaleRun = async (args) =>
      args[0] === 'status'
        ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'pc.red.ts.net.' } })
        : '{"Web":{"pc.red.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8787"}}}}}';
    const r = await tailscaleCommand('voz', {
      env: { PA_WEB_ALLOWED_HOSTS: 'pc.red.ts.net' },
      run,
    });
    expect(r.buttons).toEqual([{ label: '🎙️ Hablar', action: 'webapp:https://pc.red.ts.net/voz' }]);
  });
});
