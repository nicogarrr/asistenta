import { describe, expect, it } from 'vitest';
import { DICTADO_USAGE, dictadoPrueba } from '../src/dictado/prueba.js';
import type { WakeCapture } from '../src/voice/wake.js';

/** Micrófono falso: entrega los trozos dados al arrancar. */
function micFalso(trozos: Float32Array[], opts: { falla?: string } = {}) {
  const estado = { parado: false };
  const capture: WakeCapture = {
    start: async (onChunk) => {
      if (opts.falla) throw new Error(opts.falla);
      for (const t of trozos) onChunk(t);
    },
    stop: async () => {
      estado.parado = true;
    },
  };
  return { capture, estado };
}

const voz = () => Float32Array.from({ length: 16_000 }, (_, i) => 0.3 * Math.sin(i / 5));

function deps(capture: WakeCapture, texto = 'hola coma qué tal punto', env = {}) {
  const lineas: string[] = [];
  const pcmVisto: Float32Array[] = [];
  return {
    lineas,
    pcmVisto,
    d: {
      capture,
      transcribir: async (pcm: Float32Array) => {
        pcmVisto.push(pcm);
        return texto;
      },
      esperar: async () => {},
      out: (l: string) => lineas.push(l),
      env,
    },
  };
}

describe('pa dictado prueba', () => {
  it('graba, transcribe y enseña el texto limpio; suelta el micrófono', async () => {
    const mic = micFalso([voz(), voz()]);
    const { d, lineas, pcmVisto } = deps(mic.capture);
    expect(await dictadoPrueba([], d)).toBe(0);
    expect(lineas).toContain('Texto: Hola, qué tal.');
    expect(pcmVisto[0]?.length).toBe(32_000);
    expect(mic.estado.parado).toBe(true);
    expect(lineas.at(-1)).toMatch(/PA_DICTADO=1/);
  });

  it('con el dictado encendido no da la pista de encenderlo', async () => {
    const { d, lineas } = deps(micFalso([voz()]).capture, 'hola', { PA_DICTADO: '1' });
    expect(await dictadoPrueba(['3'], d)).toBe(0);
    expect(lineas.at(-1)).toBe('Texto: Hola');
  });

  it('silencio: no llama a la voz y lo dice claro', async () => {
    const { d, lineas, pcmVisto } = deps(micFalso([new Float32Array(16_000)]).capture);
    expect(await dictadoPrueba([], d)).toBe(1);
    expect(pcmVisto).toHaveLength(0);
    expect(lineas.at(-1)).toMatch(/No he oído nada/);
  });

  it('sin micrófono: mensaje en castellano', async () => {
    const { d, lineas } = deps(micFalso([], { falla: 'no encuentro ningun microfono' }).capture);
    expect(await dictadoPrueba([], d)).toBe(1);
    expect(lineas[0]).toMatch(/^No puedo usar el micrófono/);
  });

  it('segundos fuera de rango: explica la orden', async () => {
    const { d, lineas } = deps(micFalso([voz()]).capture);
    expect(await dictadoPrueba(['90'], d)).toBe(2);
    expect(lineas).toEqual([DICTADO_USAGE]);
  });
});
