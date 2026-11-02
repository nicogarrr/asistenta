import { describe, expect, it } from 'vitest';
import { type WakeCapture, WakeWordListener } from '../src/voice/wake.js';

// La palabra de activación escucha todo el día: el anillo del micro y la puerta de energía
// corren ~16.000 muestras por segundo. Estas pruebas fijan que copiar por bloques y medir la
// RMS sin copiar la ventana entregan a whisper exactamente las mismas muestras que antes.

class FakeCapture implements WakeCapture {
  onChunk: ((pcm: Float32Array) => void) | null = null;
  async start(onChunk: (pcm: Float32Array) => void): Promise<void> {
    this.onChunk = onChunk;
  }
  async stop(): Promise<void> {}
}

const WINDOW = 16_000 * 3;

/** La ventana de antes, muestra a muestra: las últimas WINDOW muestras, en orden. */
function reference(all: number[]): number[] {
  return all.slice(Math.max(0, all.length - WINDOW));
}

function chunk(start: number, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++)
    out[i] = 0.3 * Math.sin((start + i) * 0.37) + 0.1 * Math.cos((start + i) * 0.011);
  return out;
}

async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('energia1: anillo del micro por bloques', () => {
  it('whisper recibe las mismas muestras, en el mismo orden, con trozos de cualquier tamaño', async () => {
    const capture = new FakeCapture();
    const windows: Float32Array[] = [];
    const listener = new WakeWordListener({
      capture,
      transcriber: async (samples) => {
        windows.push(samples);
        return '';
      },
      checkIntervalMs: 100,
    });
    await listener.start();
    const all: number[] = [];
    // Trozos raros a propósito: de 1 muestra, impares, mayores que la ventana entera.
    for (const n of [1, 7, 355, 17_000, 60_000, 3, 48_001, 999]) {
      const c = chunk(all.length, n);
      capture.onChunk?.(c);
      for (const v of c) all.push(v);
    }
    await waitFor(() => windows.length > 0);
    await listener.stop();
    expect(Array.from(windows.at(-1) ?? [])).toEqual(reference(all));
  });

  it('la ventana que da la vuelta al anillo sale en orden', async () => {
    const capture = new FakeCapture();
    const windows: Float32Array[] = [];
    const listener = new WakeWordListener({
      capture,
      transcriber: async (samples) => {
        windows.push(samples);
        return '';
      },
      checkIntervalMs: 100,
    });
    await listener.start();
    const all: number[] = [];
    const feed = (n: number) => {
      const c = chunk(all.length, n);
      capture.onChunk?.(c);
      for (const v of c) all.push(v);
    };
    feed(30_000);
    await waitFor(() => windows.length > 0);
    expect(Array.from(windows.at(-1) ?? [])).toEqual(reference(all));
    const before = windows.length;
    for (let i = 0; i < 9; i++) feed(3_333);
    await waitFor(() => windows.length > before);
    await listener.stop();
    expect(windows.at(-1)?.length).toBe(WINDOW);
    expect(Array.from(windows.at(-1) ?? [])).toEqual(reference(all));
  });

  it('una ventana bajo la puerta de energía no se transcribe, aunque antes hubo voz', async () => {
    const capture = new FakeCapture();
    let calls = 0;
    const listener = new WakeWordListener({
      capture,
      transcriber: async () => {
        calls++;
        return '';
      },
      checkIntervalMs: 100,
    });
    await listener.start();
    capture.onChunk?.(chunk(0, 8_000));
    await waitFor(() => calls > 0);
    // Una ventana entera de casi silencio desplaza la voz: ya no pasa la puerta.
    capture.onChunk?.(new Float32Array(WINDOW).fill(0.001));
    const after = calls;
    await new Promise((r) => setTimeout(r, 350));
    await listener.stop();
    expect(calls).toBe(after);
  });
});
