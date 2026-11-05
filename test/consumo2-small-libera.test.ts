import { afterEach, describe, expect, it } from 'vitest';
import {
  BIG_MODEL_IDLE_MS,
  loadWhisperPipeline,
  releaseIdleWhisper,
  resetSttStateForTests,
  SMALL_STT_MODEL,
  setImportTransformersForTests,
  setWakeListening,
  TURBO_STT_MODEL,
  usingWhisper,
} from '../src/voice/stt.js';
import { type WakeCapture, WakeWordListener } from '../src/voice/wake.js';

// Consumo: whisper-small (0,7–1,2 GB) se quedaba en la RAM para siempre aunque la palabra de
// activación estuviera apagada. Ahora solo se queda mientras escucha; apagada, sale tras el
// mismo reposo que el modelo grande.
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
const later = () => Date.now() + BIG_MODEL_IDLE_MS + 1;

describe('consumo: whisper-small sale de la RAM con la palabra de activación apagada', () => {
  afterEach(() => {
    setImportTransformersForTests(null);
    resetSttStateForTests();
    st.loads = [];
    st.disposed = [];
  });

  it('sin oyente y sin uso reciente, small también se libera (antes nunca)', async () => {
    inject();
    await loadWhisperPipeline(SMALL_STT_MODEL);
    expect(await releaseIdleWhisper(later())).toEqual([SMALL_STT_MODEL]);
    expect(st.disposed).toEqual([SMALL_STT_MODEL]);
    // la siguiente vez se vuelve a cargar del disco
    await loadWhisperPipeline(SMALL_STT_MODEL);
    expect(st.loads).toEqual([SMALL_STT_MODEL, SMALL_STT_MODEL]);
  });

  it('con la palabra de activación escuchando, small se queda', async () => {
    inject();
    await loadWhisperPipeline(SMALL_STT_MODEL);
    setWakeListening(true);
    expect(await releaseIdleWhisper(later())).toEqual([]);
    setWakeListening(false);
    // recién apagada cuenta el reposo desde ahora
    expect(await releaseIdleWhisper(Date.now() + 1_000)).toEqual([]);
    expect(await releaseIdleWhisper(later() + 1_000)).toEqual([SMALL_STT_MODEL]);
  });

  it('nada se libera bajo una transcripción en curso', async () => {
    inject();
    await loadWhisperPipeline(SMALL_STT_MODEL);
    await loadWhisperPipeline(TURBO_STT_MODEL);
    let finish: () => void = () => undefined;
    const pass = usingWhisper(
      SMALL_STT_MODEL,
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    expect(await releaseIdleWhisper(later())).toEqual([]);
    finish();
    await pass;
    expect(st.disposed).toEqual([]);
  });

  it('el oyente real avisa al encenderse y al apagarse', async () => {
    inject();
    await loadWhisperPipeline(SMALL_STT_MODEL);
    const capture: WakeCapture = { start: async () => undefined, stop: async () => undefined };
    const listener = new WakeWordListener({ capture, onError: () => undefined });
    await listener.start();
    expect(await releaseIdleWhisper(later())).toEqual([]);
    await listener.stop();
    expect(await releaseIdleWhisper(later() + 1_000)).toEqual([SMALL_STT_MODEL]);
  });

  it('con un transcriptor propio el oyente no retiene small', async () => {
    inject();
    await loadWhisperPipeline(SMALL_STT_MODEL);
    const capture: WakeCapture = { start: async () => undefined, stop: async () => undefined };
    const listener = new WakeWordListener({ capture, transcriber: async () => '' });
    await listener.start();
    expect(await releaseIdleWhisper(later())).toEqual([SMALL_STT_MODEL]);
    await listener.stop();
  });
});
