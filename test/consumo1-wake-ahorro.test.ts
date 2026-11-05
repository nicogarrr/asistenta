import { afterEach, describe, expect, it } from 'vitest';
import { type WakeCapture, WakeWordListener, wakeTiming } from '../src/voice/wake.js';

// Consumo: con ruido en la sala cada comprobación de la palabra de activación es una pasada
// de whisper. PA_AHORRO=1 comprueba cada 3 s con ventana de 4,5 s: la mitad de pasadas y
// solape suficiente para que «asistenta» caiga entera en alguna ventana.
describe('consumo: modo ahorro de la palabra de activación', () => {
  const prev = process.env.PA_AHORRO;
  afterEach(() => {
    if (prev === undefined) delete process.env.PA_AHORRO;
    else process.env.PA_AHORRO = prev;
  });

  it('sin PA_AHORRO todo igual: cada 1,5 s con ventana de 3 s', () => {
    expect(wakeTiming({})).toEqual({ checkIntervalMs: 1_500, windowSeconds: 3 });
    expect(wakeTiming({ PA_AHORRO: '0' })).toEqual({ checkIntervalMs: 1_500, windowSeconds: 3 });
  });

  it('con PA_AHORRO=1: la mitad de comprobaciones y 1,5 s de solape', () => {
    const t = wakeTiming({ PA_AHORRO: '1' });
    expect(t.checkIntervalMs).toBe(3_000);
    expect(t.windowSeconds * 1000 - t.checkIntervalMs).toBeGreaterThanOrEqual(1_500);
    expect(wakeTiming({ PA_AHORRO: 'sí' }).checkIntervalMs).toBe(3_000);
  });

  it('el oyente usa la ventana de 4,5 s en ahorro (whisper la ve entera)', async () => {
    process.env.PA_AHORRO = '1';
    let push: ((pcm: Float32Array) => void) | null = null;
    const capture: WakeCapture = {
      start: async (onChunk) => {
        push = onChunk;
      },
      stop: async () => undefined,
    };
    const seen: number[] = [];
    const listener = new WakeWordListener({
      capture,
      transcriber: async (samples) => {
        seen.push(samples.length);
        return '';
      },
      checkIntervalMs: 100,
    });
    await listener.start();
    const tone = new Float32Array(16_000 * 6);
    for (let i = 0; i < tone.length; i++)
      tone[i] = Math.sin((i * 2 * Math.PI * 220) / 16_000) * 0.2;
    (push as unknown as (pcm: Float32Array) => void)(tone);
    const deadline = Date.now() + 10_000;
    while (seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    await listener.stop();
    expect(seen[0]).toBe(16_000 * 4.5);
  });
});
