import { afterEach, describe, expect, it } from 'vitest';
import { startWebUi } from '../src/webui/server.js';

const TOKEN = 'w'.repeat(32);
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
    transcribe: async () => 'hola',
    chat: async () => ({ text: 'Hola, Nico.' }),
    ...extra,
  });
  close = web.close;
  return web.url;
}

const nota = (url: string) =>
  fetch(`${url}/api/voz`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/mp4', Authorization: `Bearer ${TOKEN}` },
    body: new Uint8Array(Buffer.alloc(2000, 1)),
  });

describe('/voz: la respuesta suena con la voz del PC, no con la robótica del móvil', () => {
  it('devuelve el audio hecho en el PC junto al texto', async () => {
    const dichos: string[] = [];
    const url = await panel({
      speak: async (t: string) => {
        dichos.push(t);
        return { data: Buffer.from('ID3mp3'), mimeType: 'audio/mpeg' };
      },
    });
    const r = await nota(url);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { text: string; audio?: { mime: string; data: string } };
    expect(d.text).toBe('Hola, Nico.');
    expect(d.audio).toEqual({ mime: 'audio/mpeg', data: Buffer.from('ID3mp3').toString('base64') });
    expect(dichos).toEqual(['Hola, Nico.']);
  });

  it('si la voz del PC falla, el texto llega igual y sin audio', async () => {
    const url = await panel({
      speak: async () => {
        throw new Error('sherpa no carga');
      },
    });
    const r = await nota(url);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { text: string; audio?: unknown };
    expect(d.text).toBe('Hola, Nico.');
    expect(d.audio).toBeUndefined();
  });

  it('la página reproduce ese audio (desbloqueado en el toque) y la CSP lo deja sonar', async () => {
    const url = await panel({});
    const r = await fetch(`${url}/voz`);
    expect(r.headers.get('content-security-policy')).toContain("media-src 'self' blob: data:");
    const html = await r.text();
    expect(html).toContain('new Audio()');
    expect(html).toContain('desbloquear();');
    expect(html).toContain("hablar(x.d.text || '', x.d.audio)");
  });
});
