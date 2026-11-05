import { afterEach, describe, expect, it } from 'vitest';
import { type WakeCapture, WakeWordListener } from '../src/voice/wake.js';

// Consumo: tras una frase en una sala tranquila, la frase sigue 3 s en la ventana y whisper la
// transcribía otra vez entera (misma salida, ~3 s de CPU). Ahora se salta la pasada cuando todo
// lo nuevo es silencio y la ventana anterior ya acababa en silencio. Sin perder aciertos.
const RATE = 16_000;
const tone = (seconds: number, amp = 0.2) => {
  const out = new Float32Array(Math.round(RATE * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((i * 2 * Math.PI * 220) / RATE) * amp;
  return out;
};
const silence = (seconds: number) => new Float32Array(Math.round(RATE * seconds));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness(reply: (n: number) => string | Error = () => '') {
  let push: (pcm: Float32Array) => void = () => undefined;
  const capture: WakeCapture = {
    start: async (onChunk) => {
      push = onChunk;
    },
    stop: async () => undefined,
  };
  const calls: number[] = [];
  const wakes: string[] = [];
  const listener = new WakeWordListener({
    capture,
    word: 'asistenta',
    checkIntervalMs: 100,
    transcriber: async (samples) => {
      calls.push(samples.length);
      const r = reply(calls.length);
      if (r instanceof Error) throw r;
      return r;
    },
    onWake: (heard) => {
      wakes.push(heard);
    },
    onError: () => undefined,
  });
  const waitCalls = async (n: number) => {
    const deadline = Date.now() + 5_000;
    while (calls.length < n && Date.now() < deadline) await sleep(10);
  };
  return { listener, calls, wakes, push: (pcm: Float32Array) => push(pcm), waitCalls };
}

describe('consumo: la palabra de activación no transcribe dos veces la misma frase', () => {
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await stop?.();
    stop = null;
  });

  it('frase y luego silencio: una sola pasada de whisper (antes dos o más)', async () => {
    const h = harness();
    stop = () => h.listener.stop();
    await h.listener.start();
    h.push(tone(1));
    h.push(silence(0.5));
    await h.waitCalls(1);
    expect(h.calls.length).toBe(1);
    // Llega silencio: la frase sigue en la ventana (RMS por encima de la puerta) pero ya se vio.
    h.push(silence(0.6));
    await sleep(350);
    h.push(silence(0.6));
    await sleep(350);
    expect(h.calls.length).toBe(1);
  });

  it('sin audio nuevo no repite la pasada', async () => {
    const h = harness();
    stop = () => h.listener.stop();
    await h.listener.start();
    h.push(tone(2.5));
    await h.waitCalls(1);
    await sleep(500);
    expect(h.calls.length).toBe(1);
  });

  it('si la ventana anterior acababa con voz, vuelve a mirar aunque lo nuevo sea silencio', async () => {
    const h = harness();
    stop = () => h.listener.stop();
    await h.listener.start();
    h.push(tone(1.5));
    await h.waitCalls(1);
    h.push(silence(0.5));
    await h.waitCalls(2);
    expect(h.calls.length).toBe(2);
  });

  it('audio nuevo con voz: nueva pasada, y la palabra cortada al final se detecta entera', async () => {
    const h = harness((n) => (n === 1 ? 'asis' : 'asistenta pon música'));
    stop = () => h.listener.stop();
    await h.listener.start();
    h.push(tone(1));
    await h.waitCalls(1);
    h.push(tone(0.5));
    await h.waitCalls(2);
    await sleep(50);
    expect(h.wakes).toEqual(['asistenta pon música']);
  });

  it('si whisper falla, la misma ventana se vuelve a intentar', async () => {
    const h = harness((n) => (n === 1 ? new Error('fallo') : ''));
    stop = () => h.listener.stop();
    await h.listener.start();
    h.push(tone(1));
    h.push(silence(0.5));
    await h.waitCalls(2);
    expect(h.calls.length).toBe(2);
  });
});
