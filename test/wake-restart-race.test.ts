import { describe, expect, it } from 'vitest';
import { type WakeCapture, WakeWordListener } from '../src/voice/wake.js';

/**
 * stop() + start() mientras una pasada de whisper lenta sigue en vuelo: el tick
 * viejo vuelve con un resultado de la sesión anterior. No debe despertar en la
 * sesión nueva ni programar un segundo temporizador (dos bucles de chequeo a la
 * vez = el doble de CPU y un timer que stop() ya no puede cancelar).
 */

function tone(seconds = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * 16_000));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((i * 2 * Math.PI * 220) / 16_000) * 0.2;
  return out;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`condición no cumplida en ${ms}ms`);
    await wait(10);
  }
}

class FakeCapture implements WakeCapture {
  onChunk: ((pcm: Float32Array) => void) | null = null;
  async start(onChunk: (pcm: Float32Array) => void): Promise<void> {
    this.onChunk = onChunk;
  }
  async stop(): Promise<void> {}
  push(pcm: Float32Array): void {
    this.onChunk?.(pcm);
  }
}

describe('WakeWordListener: reinicio con transcripción lenta en vuelo', () => {
  it('descarta el resultado viejo y no deja dos bucles de chequeo', async () => {
    let releaseSlow: ((text: string) => void) | null = null;
    let calls = 0;
    const transcriber = (): Promise<string> => {
      calls++;
      if (calls === 1) {
        return new Promise<string>((resolve) => {
          releaseSlow = resolve;
        });
      }
      return Promise.resolve('nada que ver');
    };
    const wakes: string[] = [];
    const capture = new FakeCapture();
    const listener = new WakeWordListener({
      word: 'ordenador',
      capture,
      transcriber,
      checkIntervalMs: 100,
      onWake: (heard) => {
        wakes.push(heard);
      },
    });
    await listener.start();
    capture.push(tone());
    await waitFor(() => releaseSlow !== null, 2000);

    // Reinicio mientras la primera pasada sigue colgada.
    await listener.stop();
    await listener.start();
    capture.push(tone());

    // La pasada vieja termina ahora, con la palabra: es de la sesión anterior.
    const release = releaseSlow as unknown as (text: string) => void;
    release('ordenador');
    await wait(20);
    expect(wakes).toEqual([]);

    // Un solo bucle: ~1 chequeo cada 100 ms. Con el timer duplicado salen el doble.
    const before = calls;
    await wait(600);
    const during = calls - before;
    await listener.stop();
    expect(during).toBeGreaterThan(0);
    expect(during).toBeLessThanOrEqual(8);

    // Tras parar no queda ningún temporizador vivo que siga transcribiendo.
    const afterStop = calls;
    await wait(300);
    expect(calls).toBe(afterStop);
  });
});
