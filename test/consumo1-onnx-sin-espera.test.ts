import { afterEach, describe, expect, it } from 'vitest';
import { ORT_SIN_ESPERA_ACTIVA } from '../src/onnx-ahorro.js';
import { createOnnxSession } from '../src/voice/onnx-load.js';
import { loadWhisperPipeline, setImportTransformersForTests } from '../src/voice/stt.js';

// Consumo: onnxruntime deja sus hilos en espera activa entre operaciones (CPU quemada sin
// hacer nada). Con whisper-small, una pasada de la palabra de activación: 4,3 → 3,0 s de
// CPU, mismo tiempo real y mismo resultado. Todas las sesiones locales lo desactivan.
const spin = (o: unknown) =>
  (o as { extra?: { session?: { intra_op?: { allow_spinning?: string } } } } | undefined)?.extra
    ?.session?.intra_op?.allow_spinning;

describe('consumo: onnxruntime sin espera activa', () => {
  afterEach(() => setImportTransformersForTests(null));

  it('las opciones apagan la espera activa de los dos grupos de hilos', () => {
    expect(spin(ORT_SIN_ESPERA_ACTIVA)).toBe('0');
    expect(ORT_SIN_ESPERA_ACTIVA.extra.session.inter_op.allow_spinning).toBe('0');
  });

  it('whisper (palabra de activación y notas de voz) se carga con ellas', async () => {
    let seen: unknown;
    setImportTransformersForTests(
      async () =>
        ({
          LogLevel: { ERROR: 40 },
          env: {},
          pipeline: async (_t: string, _m: string, opts: { session_options?: unknown }) => {
            seen = opts.session_options;
            return async () => ({ text: '' });
          },
        }) as never,
    );
    await loadWhisperPipeline(`consumo1-test-${Math.random()}`);
    expect(spin(seen)).toBe('0');
  });

  it('VAD y palabra de activación oww (sesiones ONNX directas) también, por ruta o por bytes', async () => {
    const calls: unknown[][] = [];
    const ort = {
      InferenceSession: {
        create: async (...args: unknown[]) => {
          calls.push(args);
          return {};
        },
      },
    };
    await createOnnxSession(ort, 'C:\\m\\silero.onnx');
    await createOnnxSession(ort, 'C:\\José\\silero.onnx', async () => new Uint8Array([1, 2]));
    expect(calls.map((c) => spin(c[1]))).toEqual(['0', '0']);
  });

  it('los embeddings de la memoria también', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/memory/semantic.ts', 'utf8');
    expect(src).toMatch(
      /pipeline\('feature-extraction'[\s\S]{0,120}session_options: ORT_SIN_ESPERA_ACTIVA/,
    );
  });
});
