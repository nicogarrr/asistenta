import { afterEach, describe, expect, it } from 'vitest';
import {
  BIG_MODEL_IDLE_MS,
  loadWhisperPipeline,
  releaseIdleWhisper,
  resetSttStateForTests,
  SMALL_STT_MODEL,
  setImportTransformersForTests,
  TURBO_STT_MODEL,
  transcribeVoiceNote,
} from '../src/voice/stt.js';

// Consumo: el modelo grande de las notas de voz (turbo, ~3 GB) se quedaba en la RAM para
// siempre tras la primera nota. Tras 10 min sin notas se descarga; small (palabra de
// activación) nunca.
const st = { loads: [] as string[], disposed: [] as string[] };
function inject() {
  setImportTransformersForTests(
    async () =>
      ({
        LogLevel: { ERROR: 40 },
        env: {},
        pipeline: async (_t: string, model: string) => {
          st.loads.push(model);
          return Object.assign(async () => ({ text: '' }), {
            dispose: async () => {
              st.disposed.push(model);
            },
          });
        },
      }) as never,
  );
}

describe('consumo: el modelo grande de notas de voz sale de la RAM sin uso', () => {
  afterEach(() => {
    setImportTransformersForTests(null);
    resetSttStateForTests();
    st.loads = [];
    st.disposed = [];
  });

  it('por defecto, 10 minutos', () => {
    expect(BIG_MODEL_IDLE_MS).toBe(10 * 60_000);
  });

  it('sin notas recientes se libera turbo (dispose) y small se queda', async () => {
    inject();
    await loadWhisperPipeline(TURBO_STT_MODEL);
    await loadWhisperPipeline(SMALL_STT_MODEL);
    const released = await releaseIdleWhisper(Date.now() + BIG_MODEL_IDLE_MS + 1);
    expect(released).toEqual([TURBO_STT_MODEL]);
    expect(st.disposed).toEqual([TURBO_STT_MODEL]);
    // small sigue cargado: no se vuelve a cargar; turbo sí, la próxima vez que haga falta
    await loadWhisperPipeline(SMALL_STT_MODEL);
    await loadWhisperPipeline(TURBO_STT_MODEL);
    expect(st.loads).toEqual([TURBO_STT_MODEL, SMALL_STT_MODEL, TURBO_STT_MODEL]);
  });

  it('con una nota reciente no se libera nada', async () => {
    inject();
    await loadWhisperPipeline(TURBO_STT_MODEL);
    await transcribeVoiceNote(Buffer.alloc(0)).catch(() => undefined); // marca «nota ahora»
    expect(await releaseIdleWhisper(Date.now())).toEqual([]);
    expect(await releaseIdleWhisper(Date.now() + BIG_MODEL_IDLE_MS - 1_000)).toEqual([]);
    expect(st.disposed).toEqual([]);
  });
});
