import { describe, expect, it } from 'vitest';
import { type WakeCapture, WakeWordListener, wakeVadEnabled } from '../src/voice/wake.js';

// Consumo: con música sin voz o un ventilador la puerta de energía deja pasar todas las ventanas
// y cada una era una pasada de whisper (~3,5 s de CPU con small). El filtro de voz (Silero VAD,
// ~50 ms por ventana) las descarta; la voz pasa igual.
const tone = (seconds: number) => {
  const out = new Float32Array(Math.round(16_000 * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((i * 2 * Math.PI * 220) / 16_000) * 0.3;
  return out;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function harness(score: (s: Float32Array) => Promise<number>, reply = '') {
  let push: (pcm: Float32Array) => void = () => undefined;
  const capture: WakeCapture = {
    start: async (onChunk) => {
      push = onChunk;
    },
    stop: async () => undefined,
  };
  const calls: number[] = [];
  const scored: number[] = [];
  const wakes: string[] = [];
  const listener = new WakeWordListener({
    capture,
    word: 'asistenta',
    checkIntervalMs: 100,
    speechScore: async (s) => {
      scored.push(s.length);
      return score(s);
    },
    transcriber: async (s) => {
      calls.push(s.length);
      return reply;
    },
    onWake: (h) => {
      wakes.push(h);
    },
    onError: () => undefined,
  });
  return { listener, calls, scored, wakes, push: (p: Float32Array) => push(p) };
}

describe('consumo: filtro de voz antes de whisper en la palabra de activación', () => {
  it('sin voz (música, ventilador): no se transcribe', async () => {
    const h = harness(async () => 0.1);
    await h.listener.start();
    for (let k = 0; k < 4; k++) {
      h.push(tone(1));
      await sleep(150);
    }
    await h.listener.stop();
    expect(h.scored.length).toBeGreaterThan(0);
    expect(h.calls).toEqual([]);
  });

  it('con voz: se transcribe y la palabra despierta como siempre', async () => {
    const h = harness(async () => 0.99, ' asistenta pon música');
    await h.listener.start();
    h.push(tone(1.5));
    const deadline = Date.now() + 3_000;
    while (h.wakes.length === 0 && Date.now() < deadline) await sleep(10);
    await h.listener.stop();
    expect(h.calls.length).toBe(1);
    expect(h.wakes).toEqual([' asistenta pon música']);
  });

  it('si el filtro falla, se transcribe igual (nunca deja sorda la palabra)', async () => {
    const h = harness(async () => {
      throw new Error('sin modelo');
    });
    await h.listener.start();
    h.push(tone(1.5));
    const deadline = Date.now() + 3_000;
    while (h.calls.length === 0 && Date.now() < deadline) await sleep(10);
    await h.listener.stop();
    expect(h.calls.length).toBe(1);
    expect(h.listener.isRunning()).toBe(false);
  });

  it('encendido por defecto; PA_WAKE_VAD=0 lo quita', () => {
    expect(wakeVadEnabled({})).toBe(true);
    expect(wakeVadEnabled({ PA_WAKE_VAD: '1' })).toBe(true);
    expect(wakeVadEnabled({ PA_WAKE_VAD: '0' })).toBe(false);
    expect(wakeVadEnabled({ PA_WAKE_VAD: 'off' })).toBe(false);
  });
});
