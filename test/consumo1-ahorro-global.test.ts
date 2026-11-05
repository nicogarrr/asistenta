import { afterEach, describe, expect, it } from 'vitest';
import { modoAhorro } from '../src/ahorro.js';
import {
  BROWSER_IDLE_CLOSE_AHORRO_MS,
  BROWSER_IDLE_CLOSE_MS,
  browserIdleCloseDefaultMs,
} from '../src/browser/service.js';
import {
  BIG_MODEL_IDLE_AHORRO_MS,
  bigModelIdleMs,
  loadWhisperPipeline,
  releaseIdleWhisper,
  resetSttStateForTests,
  setImportTransformersForTests,
  TURBO_STT_MODEL,
} from '../src/voice/stt.js';
import { wakeTiming } from '../src/voice/wake.js';

// Consumo: PA_AHORRO=1 vale para todo lo que se queda encendido sin uso, no solo para la
// palabra de activación: navegador sin ventana 10 → 3 min, modelo grande de voz 10 → 2 min.
describe('consumo: modo ahorro global (PA_AHORRO=1)', () => {
  const prev = process.env.PA_AHORRO;
  afterEach(() => {
    if (prev === undefined) delete process.env.PA_AHORRO;
    else process.env.PA_AHORRO = prev;
    setImportTransformersForTests(null);
    resetSttStateForTests();
  });

  it('una sola lectura de la variable', () => {
    expect(modoAhorro({})).toBe(false);
    expect(modoAhorro({ PA_AHORRO: '0' })).toBe(false);
    expect(modoAhorro({ PA_AHORRO: ' Sí ' })).toBe(true);
    expect(modoAhorro({ PA_AHORRO: '1' })).toBe(true);
    expect(wakeTiming({ PA_AHORRO: 'on' }).checkIntervalMs).toBe(3_000);
  });

  it('navegador sin ventana: 10 min normal, 3 min en ahorro', () => {
    expect(browserIdleCloseDefaultMs({})).toBe(BROWSER_IDLE_CLOSE_MS);
    expect(browserIdleCloseDefaultMs({ PA_AHORRO: '1' })).toBe(3 * 60_000);
    expect(BROWSER_IDLE_CLOSE_AHORRO_MS).toBe(3 * 60_000);
  });

  it('modelo grande de notas de voz: 10 min normal, 2 min en ahorro', async () => {
    expect(bigModelIdleMs({})).toBe(10 * 60_000);
    expect(bigModelIdleMs({ PA_AHORRO: '1' })).toBe(BIG_MODEL_IDLE_AHORRO_MS);
    expect(BIG_MODEL_IDLE_AHORRO_MS).toBe(2 * 60_000);
    // y de verdad: con PA_AHORRO=1, a los 2 min sin notas turbo sale de la RAM
    process.env.PA_AHORRO = '1';
    const disposed: string[] = [];
    setImportTransformersForTests(
      async () =>
        ({
          LogLevel: { ERROR: 40 },
          env: {},
          pipeline: async (_t: string, model: string) =>
            Object.assign(async () => ({ text: '' }), {
              dispose: async () => {
                disposed.push(model);
              },
            }),
        }) as never,
    );
    await loadWhisperPipeline(TURBO_STT_MODEL);
    expect(await releaseIdleWhisper(Date.now() + 2 * 60_000 + 1)).toEqual([TURBO_STT_MODEL]);
    expect(disposed).toEqual([TURBO_STT_MODEL]);
  });
});
