import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/log.js';
import { startWebUi } from '../src/webui/server.js';
import { renderVozPage } from '../src/webui/voz-page.js';
import { tomarResto } from '../src/webui/voz-rapida.js';
import {
  CortadorFrases,
  type EventoVoz,
  PERDONA_OIR,
  PERDONA_PENSAR,
  restoPorDecir,
  turnoVoz,
  type VozTurnoDeps,
  vozPanelPrompt,
} from '../src/webui/voz-turno.js';

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mp3 = (t: string) => ({ data: Buffer.from(`mp3:${t}`), mimeType: 'audio/mpeg' });

async function correr(deps: VozTurnoDeps): Promise<EventoVoz[]> {
  const eventos: EventoVoz[] = [];
  await turnoVoz(Buffer.alloc(10), 'audio/wav', deps, (e) => eventos.push(e), {
    inicio: Date.now(),
    recibirMs: 3,
  });
  return eventos;
}
const frases = (ev: EventoVoz[]) =>
  ev.flatMap((e) => (e.tipo === 'frase' ? [{ texto: e.texto, audio: Boolean(e.audio) }] : []));
const fin = (ev: EventoVoz[]) =>
  ev.find((e) => e.tipo === 'fin') as Extract<EventoVoz, { tipo: 'fin' }>;

afterEach(() => vi.restoreAllMocks());

describe('/voz nunca se queda callada (voz7)', () => {
  it('whisper falla: lo dice por escrito y en voz alta («Perdona, no te he oído bien»)', async () => {
    const ev = await correr({
      transcribe: async () => {
        throw new Error('ffmpeg no está');
      },
      chat: async () => ({ text: 'no debería' }),
      speak: async (t) => mp3(t),
    });
    expect(frases(ev)).toEqual([{ texto: PERDONA_OIR, audio: true }]);
    expect(fin(ev).fallo).toBe('oir');
    expect(fin(ev).text).toContain('ffmpeg no está');
  });

  it('whisper colgado: pasado su tope contesta igual', async () => {
    const ev = await correr({
      transcribe: () => new Promise<string>(() => {}),
      chat: async () => ({ text: 'x' }),
      topeOirMs: 50,
    });
    expect(fin(ev).fallo).toBe('oir');
    // Sin voz del PC la frase va sin audio: la página la lee con la voz del móvil.
    expect(frases(ev)).toEqual([{ texto: PERDONA_OIR, audio: false }]);
  });

  it('el agente falla: frase hablada de disculpa, nunca un 500 mudo', async () => {
    const ev = await correr({
      transcribe: async () => '¿qué tengo hoy?',
      chat: async () => {
        throw new Error('Error 529 overloaded');
      },
      speak: async (t) => mp3(t),
    });
    expect(frases(ev)).toEqual([{ texto: PERDONA_PENSAR, audio: true }]);
    expect(fin(ev).fallo).toBe('pensar');
    expect(fin(ev).text).toContain('Reintentar');
  });

  it('el agente tarda más que su tope: «sigo pensándolo» ya, y la respuesta llega después', async () => {
    const ev = await correr({
      transcribe: async () => 'resume mi correo',
      chat: async () => {
        await espera(150);
        return { text: 'Tienes tres correos nuevos.' };
      },
      speak: async (t) => mp3(t),
      topePensarMs: 30,
    });
    const f = fin(ev);
    expect(f.fallo).toBe('tarde');
    expect(frases(ev)[0]?.texto).toMatch(/Sigo pensándolo/);
    expect(f.pendiente).toBeTruthy();
    const luego = (await tomarResto(f.pendiente ?? '')) as {
      text: string;
      audio?: { data: string };
    };
    expect(luego.text).toBe('Tienes tres correos nuevos.');
    expect(Buffer.from(luego.audio?.data ?? '', 'base64').toString()).toBe(
      'mp3:Tienes tres correos nuevos.',
    );
  });

  it('la voz del PC falla en una frase: la frase sale igual (sin audio) y el texto completo', async () => {
    const ev = await correr({
      transcribe: async () => 'hola qué hora es',
      chat: async () => ({ text: 'Son las cinco.' }),
      speak: async () => {
        throw new Error('sherpa no carga');
      },
    });
    expect(frases(ev)).toEqual([{ texto: 'Son las cinco.', audio: false }]);
    expect(fin(ev).text).toBe('Son las cinco.');
  });

  it('la página dice el fallo en voz alta (voz del móvil) y enseña Escuchando/Pensando/Hablando', () => {
    const html = renderVozPage();
    const fallo = html.slice(html.indexOf('function fallo('), html.indexOf('function alEvento('));
    expect(fallo).toContain('vozSistema(hablado || texto');
    expect(fallo).toContain("linea('ella', texto)");
    expect(html).toContain('Escuchando…');
    expect(html).toContain("decir('Pensando…')");
    expect(html).toContain("decir('Hablando…')");
    expect(html).toContain("Accept: 'application/x-ndjson'");
    expect(html).toContain('id="vertiempos"');
  });
});

describe('/voz mide cada etapa y la apunta en el registro (voz7)', () => {
  it('recibir, oír, pensar, primera voz, voz y total en «voz movil: tiempos»', async () => {
    const info = vi.spyOn(log, 'info');
    await correr({
      transcribe: async () => {
        await espera(30);
        return 'qué tiempo hace';
      },
      chat: async () => {
        await espera(60);
        return { text: 'Hace sol.' };
      },
      speak: async (t) => {
        await espera(20);
        return mp3(t);
      },
    });
    const linea = info.mock.calls.find((c) => c[0] === 'voz movil: tiempos');
    expect(linea).toBeTruthy();
    const t = linea?.[1] as Record<string, number>;
    expect(t.recibirMs).toBe(3);
    expect(t.oirMs).toBeGreaterThanOrEqual(25);
    expect(t.pensarMs).toBeGreaterThanOrEqual(55);
    expect(t.vozMs).toBeGreaterThanOrEqual(15);
    expect(t.primeraVozMs).toBeGreaterThanOrEqual(t.oirMs + t.pensarMs);
    expect(t.totalMs).toBeGreaterThanOrEqual(t.primeraVozMs);
  });
});

describe('/voz habla con la primera frase mientras el agente sigue escribiendo (voz7)', () => {
  it('la primera frase suena antes de que el agente acabe', async () => {
    const orden: string[] = [];
    const ev: EventoVoz[] = [];
    await turnoVoz(
      Buffer.alloc(10),
      'audio/wav',
      {
        transcribe: async () => '¿qué tengo mañana?',
        chat: async (_t, { onDelta }) => {
          onDelta('Mañana tienes ');
          onDelta('el dentista a las diez. Después');
          await espera(200);
          onDelta(', a las doce, la reunión con el gestor.');
          orden.push('agente-acaba');
          return {
            text: 'Mañana tienes el dentista a las diez. Después, a las doce, la reunión con el gestor.',
          };
        },
        speak: async (t) => mp3(t),
      },
      (e) => {
        ev.push(e);
        if (e.tipo === 'frase') orden.push(`frase:${e.texto}`);
      },
      { inicio: Date.now(), recibirMs: 0 },
    );
    expect(orden[0]).toBe('frase:Mañana tienes el dentista a las diez.');
    expect(orden[1]).toBe('agente-acaba');
    // El resto se dice una sola vez, sin repetir la primera.
    expect(frases(ev).map((f) => f.texto)).toEqual([
      'Mañana tienes el dentista a las diez.',
      'Después, a las doce, la reunión con el gestor.',
    ]);
  });

  it('por HTTP en flujo (NDJSON): la frase llega al móvil antes de que el agente acabe', async () => {
    const TOKEN = 'v'.repeat(32);
    let acabar: (() => void) | undefined;
    const web = await startWebUi({
      token: TOKEN,
      status: () => ({}),
      sessions: () => [],
      memory: () => [],
      auditVerify: () => ({}),
      transcribe: async () => 'cuéntame algo',
      chat: async (_t: string, o?: { onDelta?: (d: string) => void; voz?: boolean }) => {
        expect(o?.voz).toBe(true);
        o?.onDelta?.('Vale, te cuento una cosa. ');
        await new Promise<void>((r) => {
          acabar = r;
        });
        return { text: 'Vale, te cuento una cosa. Hoy hace sol.' };
      },
      speak: async (t: string) => mp3(t),
    });
    try {
      const r = await fetch(`${web.url}/api/voz`, {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/wav',
          Accept: 'application/x-ndjson',
          Authorization: `Bearer ${TOKEN}`,
        },
        body: new Uint8Array(Buffer.alloc(100, 1)),
      });
      expect(r.headers.get('content-type')).toContain('application/x-ndjson');
      const lector = r.body?.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const lineas: Array<Record<string, unknown>> = [];
      while (!lineas.some((l) => l.tipo === 'frase')) {
        const x = await lector?.read();
        if (!x || x.done) break;
        buf += dec.decode(x.value, { stream: true });
        const partes = buf.split('\n');
        buf = partes.pop() ?? '';
        for (const p of partes) if (p.trim()) lineas.push(JSON.parse(p));
      }
      const frase = lineas.find((l) => l.tipo === 'frase');
      expect(frase?.texto).toBe('Vale, te cuento una cosa.');
      expect(acabar).toBeTypeOf('function'); // el agente sigue «pensando»
      acabar?.();
      let resto = buf;
      for (;;) {
        const x = await lector?.read();
        if (!x || x.done) break;
        resto += dec.decode(x.value, { stream: true });
      }
      const finales = resto
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(finales.find((l) => l.tipo === 'frase')?.texto).toBe('Hoy hace sol.');
      expect(finales.at(-1)?.tipo).toBe('fin');
      expect(finales.at(-1)?.text).toBe('Vale, te cuento una cosa. Hoy hace sol.');
    } finally {
      await web.close();
    }
  });

  it('cortador: «3.5» no se corta, y restoPorDecir no repite lo ya dicho', () => {
    const c = new CortadorFrases();
    expect(c.push('Cuesta 3.5 euros')).toEqual([]);
    expect(c.push(' el kilo. Y')).toEqual(['Cuesta 3.5 euros el kilo.']);
    expect(restoPorDecir('Hola Nico. ¿Qué tal?', ['Hola Nico.'])).toBe('¿Qué tal?');
    expect(restoPorDecir('Otra cosa.', ['Hola Nico.'])).toBe('Otra cosa.');
    expect(vozPanelPrompt('qué hora es')).toMatch(/1 a 3 frases.*qué hora es$/);
  });
});
