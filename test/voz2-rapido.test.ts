import { afterEach, describe, expect, it } from 'vitest';
import { startWebUi } from '../src/webui/server.js';
import { partirPrimeraFrase, respuestaRapida } from '../src/webui/voz-rapida.js';

const TOKEN = 'r'.repeat(32);
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Camino simulado: whisper 200 ms, agente 1200 ms, voz 4 ms por carácter.
const STT_MS = 200;
const AGENTE_MS = 1200;

async function panel(oido: string, respuesta: string, extra: Record<string, unknown> = {}) {
  const llamadas = { chat: 0, speak: [] as string[], prewarm: 0 };
  const web = await startWebUi({
    token: TOKEN,
    status: () => ({}),
    sessions: () => [],
    memory: () => [],
    auditVerify: () => ({}),
    transcribe: async () => {
      await espera(STT_MS);
      return oido;
    },
    chat: async () => {
      llamadas.chat++;
      await espera(AGENTE_MS);
      return { text: respuesta };
    },
    speak: async (t: string) => {
      llamadas.speak.push(t);
      await espera(4 * t.length);
      return { data: Buffer.from(`mp3:${t}`), mimeType: 'audio/mpeg' };
    },
    prewarm: () => {
      llamadas.prewarm++;
    },
    ...extra,
  });
  close = web.close;
  return { url: web.url, llamadas };
}

const nota = (url: string) =>
  fetch(`${url}/api/voz`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/mp4', Authorization: `Bearer ${TOKEN}` },
    body: new Uint8Array(Buffer.alloc(2000, 1)),
  });

interface Respuesta {
  text: string;
  audio?: { mime: string; data: string };
  audioResto?: string;
  tiempos?: { oirMs: number; pensarMs: number; vozMs: number; totalMs: number; rapida: boolean };
}

describe('/voz rápido: un «hola» no tarda medio minuto', () => {
  it('«hola» contesta al momento sin pasar por el agente, y dice cuánto tardó cada parte', async () => {
    const { url, llamadas } = await panel('¡Hola!', 'no debería usarse');
    const t0 = Date.now();
    const d = (await (await nota(url)).json()) as Respuesta;
    const ms = Date.now() - t0;
    expect(llamadas.chat).toBe(0);
    expect(d.text).toMatch(/^¡Hola, Nico!/);
    expect(d.audio?.data).toBeTruthy();
    expect(d.tiempos?.rapida).toBe(true);
    expect(d.tiempos?.oirMs).toBeGreaterThanOrEqual(STT_MS - 20);
    expect(d.tiempos?.pensarMs).toBeLessThan(50);
    // Antes: whisper + agente + voz ≈ 1,6 s en este camino simulado.
    expect(ms).toBeLessThan(STT_MS + AGENTE_MS);
  });

  it('una pregunta de verdad sí va al agente; la voz empieza con la primera frase', async () => {
    const larga =
      'Mañana a las diez tienes el dentista en la calle Mayor. ' +
      'Después, a las doce, la reunión con el gestor para revisar la declaración trimestral. ' +
      'Y por la tarde nada más, así que puedes hacer el pedido de Mercadona con calma.';
    const { url, llamadas } = await panel('¿Qué tengo mañana?', larga);
    const d = (await (await nota(url)).json()) as Respuesta;
    expect(llamadas.chat).toBe(1);
    expect(llamadas.speak[0]).toBe('Mañana a las diez tienes el dentista en la calle Mayor.');
    expect(Buffer.from(d.audio?.data ?? '', 'base64').toString()).toBe(`mp3:${llamadas.speak[0]}`);
    expect(d.tiempos?.vozMs).toBeLessThan(4 * larga.length);
    expect(d.audioResto).toBeTruthy();
    const resto = await fetch(`${url}/api/voz/resto?id=${d.audioResto}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(resto.status).toBe(200);
    const r = (await resto.json()) as { data: string };
    expect(Buffer.from(r.data, 'base64').toString()).toMatch(/^mp3:Después, a las doce/);
    // Se entrega una vez y caduca.
    const otra = await fetch(`${url}/api/voz/resto?id=${d.audioResto}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(otra.status).toBe(404);
  });

  it('abrir /voz precarga whisper y la voz en el PC, y la página enseña los tiempos', async () => {
    const { url, llamadas } = await panel('hola', 'x');
    const html = await (await fetch(`${url}/voz`)).text();
    expect(llamadas.prewarm).toBe(1);
    expect(html).toContain('id="tiempos"');
    expect(html).toContain('/api/voz/resto?id=');
  });

  it('solo los saludos y «gracias» sueltos van por el atajo', () => {
    expect(respuestaRapida('Hola.')).toMatch(/Hola/);
    expect(respuestaRapida('buenos días, Asistenta')).toMatch(/Buenos días/);
    expect(respuestaRapida('Gracias')).toMatch(/De nada/);
    expect(respuestaRapida('hola, ¿qué tiempo hace mañana?')).toBeNull();
    expect(respuestaRapida('apaga la tele')).toBeNull();
    expect(partirPrimeraFrase('Vale.')).toEqual(['Vale.', '']);
  });
});
