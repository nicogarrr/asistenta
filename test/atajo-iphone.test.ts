import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ATAJO_FALLO,
  ATAJO_TARDE,
  ATAJO_TARDE_SIN_TELEGRAM,
  atajoModo,
  atajoPrompt,
  responderAtajo,
  textoPlano,
} from '../src/webui/atajo.js';
import { startWebUi, type WebUiDeps } from '../src/webui/server.js';

// Atajos del iPhone (Nico, 7 nov): «Oye Siri, pregunta a Asistenta» y «Mandar a Asistenta».
// La app Atajos manda JSON y lee en voz alta lo que recibe: texto plano, sin Markdown, y
// nunca un error de tiempo mudo (Atajos corta hacia los 60 s).

const TOKEN = 'token-atajo-123';
const recibido: string[] = [];
const avisos: string[] = [];
let lento: (() => void) | null = null;

const deps: WebUiDeps = {
  token: TOKEN,
  status: () => ({ ok: true }),
  sessions: () => [],
  memory: () => [],
  auditVerify: () => ({ ok: true }),
  chat: async (text) => {
    recibido.push(text);
    if (text.includes('tarda')) {
      await new Promise<void>((r) => {
        lento = r;
      });
      return { text: 'Respuesta **lenta**' };
    }
    if (text.includes('rompe')) throw new Error('modelo caído');
    return { text: '**Mañana** a las 9 tienes `dentista`. [Mapa](https://maps.example/x)' };
  },
  avisarTelegram: async (text) => {
    avisos.push(text);
  },
  atajoTopeMs: 150,
};

let ui: Awaited<ReturnType<typeof startWebUi>>;
beforeAll(async () => {
  ui = await startWebUi(deps);
});
afterAll(async () => {
  await ui.close();
});

function post(body: unknown, token: string | null = TOKEN): Promise<Response> {
  return fetch(new URL('/api/atajo', ui.url), {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/atajo (Atajos del iPhone)', () => {
  it('devuelve texto plano sin Markdown, listo para «Leer texto»', async () => {
    const res = await post({ text: '¿qué tengo mañana?' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('Mañana a las 9 tienes dentista. Mapa');
  });

  it('por defecto pide respuesta corta para voz; modo texto pide respuesta de pantalla', async () => {
    recibido.length = 0;
    await post({ text: 'hola' });
    await post({ text: 'https://amazon.es/dp/X', modo: 'texto' });
    expect(recibido[0]).toContain('Siri');
    expect(recibido[0]).toContain('1 a 3 frases');
    expect(recibido[0]?.endsWith('hola')).toBe(true);
    expect(recibido[1]).toContain('pantalla');
    expect(recibido[1]).not.toContain('1 a 3 frases');
  });

  it('sin token contesta 401 con una frase que el iPhone puede leer', async () => {
    const res = await post({ text: 'hola' }, 'malo');
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toMatch(/token/i);
  });

  it('sin texto o con JSON roto contesta una frase, no JSON', async () => {
    const vacio = await post({ text: '  ' });
    expect(vacio.status).toBe(400);
    expect(await vacio.text()).toMatch(/No me ha llegado nada/);
    const roto = await post('{no');
    expect(roto.status).toBe(400);
    expect(roto.headers.get('content-type')).toContain('text/plain');
  });

  it('si el turno falla lo dice en una frase', async () => {
    const res = await post({ text: 'esto rompe' });
    expect(await res.text()).toBe(ATAJO_FALLO);
  });

  it('si tarda más del tope contesta al momento y manda la respuesta por Telegram', async () => {
    avisos.length = 0;
    const res = await post({ text: 'esto tarda mucho' });
    expect(await res.text()).toBe(ATAJO_TARDE);
    expect(avisos).toEqual([]);
    lento?.();
    await new Promise((r) => setTimeout(r, 50));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('esto tarda mucho');
    expect(avisos[0]).toContain('Respuesta **lenta**');
  });
});

describe('atajo.ts', () => {
  it('modo: solo «texto» cambia el modo', () => {
    expect(atajoModo('texto')).toBe('texto');
    expect(atajoModo(' TEXTO ')).toBe('texto');
    expect(atajoModo(undefined)).toBe('voz');
    expect(atajoModo('otro')).toBe('voz');
  });

  it('quita encabezados, viñetas y negritas', () => {
    expect(textoPlano('# Hoy\n- **uno**\n- dos')).toBe('Hoy\nuno\ndos');
  });

  it('el prompt lleva la petición tal cual al final', () => {
    expect(atajoPrompt('apaga la tele', 'voz').endsWith(' apaga la tele')).toBe(true);
  });

  it('sin Telegram, tarde dice que pregunte otra vez', async () => {
    const r = await responderAtajo('x', 'voz', {
      chat: () => new Promise(() => {}),
      topeMs: 10,
    });
    expect(r).toBe(ATAJO_TARDE_SIN_TELEGRAM);
  });
});
