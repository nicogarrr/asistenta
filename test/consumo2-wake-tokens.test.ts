import { afterEach, describe, expect, it } from 'vitest';
import { resetSttStateForTests, setImportTransformersForTests } from '../src/voice/stt.js';
import {
  defaultTranscriber,
  WAKE_MAX_NEW_TOKENS,
  type WakeCapture,
  WakeWordListener,
} from '../src/voice/wake.js';

// Consumo: con ruido o música whisper puede entrar en bucle y decodificar cientos de tokens en
// una sola comprobación de la palabra de activación (medido: 6–17 s de CPU frente a ~1,4 s).
// La comprobación pide como mucho WAKE_MAX_NEW_TOKENS: una frase de 3–4,5 s cabe de sobra.
describe('consumo: la palabra de activación acota los tokens de cada pasada', () => {
  afterEach(() => {
    setImportTransformersForTests(null);
    resetSttStateForTests();
  });

  it('pasa max_new_tokens a whisper (antes sin tope)', async () => {
    const seen: Record<string, unknown>[] = [];
    setImportTransformersForTests(
      async () =>
        ({
          LogLevel: { ERROR: 40 },
          env: {},
          pipeline: async () => async (_audio: Float32Array, options: Record<string, unknown>) => {
            seen.push(options);
            return { text: ' asistenta' };
          },
        }) as never,
    );
    const text = await defaultTranscriber(new Float32Array(16_000), 'asistenta');
    expect(text).toBe(' asistenta');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.max_new_tokens).toBe(64);
    expect(WAKE_MAX_NEW_TOKENS).toBe(64);
    // lo de siempre sigue igual
    expect(seen[0]).toMatchObject({
      language: 'spanish',
      task: 'transcribe',
      initial_prompt: 'asistenta',
    });
  });

  it('el tope deja sitio de sobra a una frase de 4,5 s y corta un bucle', () => {
    // ~15 palabras en 4,5 s ≈ 30 tokens; un bucle llega a 448 (el máximo de whisper).
    expect(WAKE_MAX_NEW_TOKENS).toBeGreaterThanOrEqual(60);
    expect(WAKE_MAX_NEW_TOKENS).toBeLessThanOrEqual(100);
  });

  it('whisper sin ningún token (ruido sin voz) es «no se oyó nada», no un fallo', async () => {
    setImportTransformersForTests(
      async () =>
        ({
          LogLevel: { ERROR: 40 },
          env: {},
          pipeline: async () => async () => {
            throw new Error('token_ids must be a non-empty array of integers.');
          },
        }) as never,
    );
    expect(await defaultTranscriber(new Float32Array(16_000), 'asistenta')).toBe('');
  });

  it('tres ventanas así seguidas ya no apagan la palabra de activación', async () => {
    setImportTransformersForTests(
      async () =>
        ({
          LogLevel: { ERROR: 40 },
          env: {},
          pipeline: async () => async () => {
            throw new Error('token_ids must be a non-empty array of integers.');
          },
        }) as never,
    );
    let push: (pcm: Float32Array) => void = () => undefined;
    const capture: WakeCapture = {
      start: async (onChunk) => {
        push = onChunk;
      },
      stop: async () => undefined,
    };
    const errors: string[] = [];
    const listener = new WakeWordListener({
      capture,
      checkIntervalMs: 100,
      onError: (e) => errors.push(e.message),
    });
    await listener.start();
    const loud = new Float32Array(16_000 * 3);
    for (let i = 0; i < loud.length; i++) loud[i] = Math.sin(i / 7) * 0.3;
    for (let k = 0; k < 5; k++) {
      push(loud);
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(listener.isRunning()).toBe(true);
    expect(errors).toEqual([]);
    await listener.stop();
  });
});
