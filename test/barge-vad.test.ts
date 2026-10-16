import { describe, expect, it } from 'vitest';
import { scoreSamples } from '../src/voice/barge-vad.js';
import {
  SileroVad,
  VAD_STATE_DIM,
  VAD_STATE_LAYERS,
  VAD_WINDOW_SAMPLES,
  type VadSession,
} from '../src/voice/vad-silero.js';

/**
 * Sesión ONNX falsa: la prob de habla es la amplitud máxima del frame, así un
 * tono fuerte puntúa "habla" y el silencio/ruido bajo no. El estado siguiente
 * se devuelve con la forma exacta que el runner exige.
 */
function fakeSession(): { session: VadSession; runs: number[] } {
  const runs: number[] = [];
  const state = (): { data: Float32Array; dims: number[] } => ({
    data: new Float32Array(VAD_STATE_LAYERS * VAD_STATE_DIM),
    dims: [VAD_STATE_LAYERS, 1, VAD_STATE_DIM],
  });
  return {
    runs,
    session: {
      inputNames: ['input'],
      outputNames: ['output'],
      run: async (feeds) => {
        const frame = feeds['input']?.data as Float32Array;
        runs.push(frame.length);
        let max = 0;
        for (const s of frame) max = Math.max(max, Math.abs(s));
        return {
          output: { data: new Float32Array([max]), dims: [1, 1] },
          hn: state(),
          cn: state(),
        };
      },
      release: async () => {},
    },
  };
}

const tone = (n: number, amp: number): Float32Array => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / 16_000);
  return out;
};

describe('scoreSamples', () => {
  it('puntúa por el frame con más habla y resetea el contexto antes', async () => {
    const { session } = fakeSession();
    const vad = SileroVad.overSession(session);
    // Contexto previo que NO debe contaminar la puntuación del candidato.
    await vad.pushFrame(tone(VAD_WINDOW_SAMPLES, 0.9));

    const quiet = tone(VAD_WINDOW_SAMPLES, 0.01);
    const speech = tone(VAD_WINDOW_SAMPLES, 0.8);
    const samples = new Float32Array(VAD_WINDOW_SAMPLES * 2);
    samples.set(quiet, 0);
    samples.set(speech, VAD_WINDOW_SAMPLES);
    const prob = await scoreSamples(vad, samples);
    expect(prob).toBeGreaterThan(0.7);
  });

  it('silencio o ruido muy bajo puntúa por debajo del umbral de corte', async () => {
    const { session } = fakeSession();
    const vad = SileroVad.overSession(session);
    const prob = await scoreSamples(vad, tone(VAD_WINDOW_SAMPLES * 3, 0.02));
    expect(prob).toBeLessThan(0.5);
  });

  it('menos de una ventana se puntúa con padding, no se descarta', async () => {
    const { session, runs } = fakeSession();
    const vad = SileroVad.overSession(session);
    const prob = await scoreSamples(vad, tone(100, 0.9));
    expect(prob).toBeGreaterThan(0.8);
    expect(runs).toEqual([VAD_WINDOW_SAMPLES]);
  });

  it('ignora la cola que no llega a una ventana completa', async () => {
    const { session, runs } = fakeSession();
    const vad = SileroVad.overSession(session);
    // 2 ventanas completas + 100 muestras fuertes: la cola no entra en la prob.
    const samples = new Float32Array(VAD_WINDOW_SAMPLES * 2 + 100);
    samples.set(tone(VAD_WINDOW_SAMPLES, 0.01), 0);
    samples.set(tone(VAD_WINDOW_SAMPLES, 0.01), VAD_WINDOW_SAMPLES);
    samples.set(tone(100, 0.99), VAD_WINDOW_SAMPLES * 2);
    const prob = await scoreSamples(vad, samples);
    expect(prob).toBeLessThan(0.5);
    expect(runs).toEqual([VAD_WINDOW_SAMPLES, VAD_WINDOW_SAMPLES]);
  });
});
