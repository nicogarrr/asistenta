// Motor oww del WakeWordListener (A1b wiring, PA_WAKE_ENGINE=oww): el runner
// openWakeWord dedicado queda conectado al oyente detras de flag. Sesiones
// ONNX falsas con la logica de formas oficial (como wakeword-oww.test.ts) y
// scores del clasificador guionizados: se prueba el CABLEADO (trozado en
// frames, disparo por umbral, suppression/hold con reset, cierre), no la
// numerica del modelo — esa la cubre scripts/wakeword-parity.* (opt-in).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';
import type { WakeCapture } from '../src/voice/wake.js';
import { WakeWordListener } from '../src/voice/wake.js';
import {
  OWW_EMB_SIZE,
  OWW_EMB_WINDOW,
  OWW_FRAME_SAMPLES,
  OWW_MEL_BINS,
  OWW_MEL_WINDOW,
  type OwwSession,
  OwwWakeDetector,
} from '../src/voice/wakeword-oww.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await wait(20);
  }
}

class FakeCapture implements WakeCapture {
  onChunk: ((pcm: Float32Array) => void) | null = null;
  stopCalls = 0;
  async start(onChunk: (pcm: Float32Array) => void): Promise<void> {
    this.onChunk = onChunk;
  }
  async stop(): Promise<void> {
    this.stopCalls++;
  }
}

/** Frames mel oficiales para N muestras de entrada (utils.py v0.5.1). */
const officialMelFrames = (samples: number) => Math.floor((samples - 480) / 160);

/**
 * Sesiones falsas con las formas oficiales; el clasificador devuelve scores
 * de `scoreScript` en orden de llamada (y el ultimo en bucle si se agota).
 */
function fakeSessions(scoreScript: number[]) {
  const released: string[] = [];
  let classifierCalls = 0;
  const melspec: OwwSession = {
    inputNames: ['input'],
    outputNames: ['output'],
    run: async (feeds) => {
      const len = feeds.input?.dims[1] ?? 0;
      const frames = officialMelFrames(len);
      return {
        output: {
          data: new Float32Array(frames * OWW_MEL_BINS).fill(12),
          dims: [1, 1, frames, OWW_MEL_BINS],
        },
      };
    },
    release: async () => {
      released.push('melspec');
    },
  };
  const embedding: OwwSession = {
    inputNames: ['input_1'],
    outputNames: ['conv2d_19'],
    run: async (feeds) => {
      const t = feeds.input_1;
      if (t?.data.length !== OWW_MEL_WINDOW * OWW_MEL_BINS) throw new Error('ventana mel mal');
      return { conv2d_19: { data: new Float32Array(OWW_EMB_SIZE), dims: [1, 1, 1, OWW_EMB_SIZE] } };
    },
    release: async () => {
      released.push('embedding');
    },
  };
  const classifier: OwwSession = {
    inputNames: ['x.1'],
    outputNames: ['53'],
    run: async (feeds) => {
      const t = feeds['x.1'];
      if (t?.data.length !== OWW_EMB_WINDOW * OWW_EMB_SIZE) throw new Error('ventana emb mal');
      const score = scoreScript[Math.min(classifierCalls, scoreScript.length - 1)] ?? 0;
      classifierCalls++;
      return { 53: { data: new Float32Array([score]), dims: [1, 1] } };
    },
    release: async () => {
      released.push('classifier');
    },
  };
  return { sessions: { melspec, embedding, classifier }, released };
}

function makeListener(opts: {
  scoreScript: number[];
  threshold?: number;
  wakes: string[];
  capture: FakeCapture;
}): WakeWordListener {
  const { sessions } = fakeSessions(opts.scoreScript);
  const detector = OwwWakeDetector.overSessions(sessions);
  const listener = new WakeWordListener({
    word: 'chochi',
    engine: 'oww',
    oww: {
      modelDir: '/no/importa',
      wordModelFile: 'chochi.onnx',
      ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      detector,
    },
    capture: opts.capture,
    onWake: (heard) => {
      opts.wakes.push(heard);
    },
  });
  return listener;
}

/** Empuja `frames` frames de 1280 muestras por el capture (en un chunk). */
function pushFrames(capture: FakeCapture, frames: number): void {
  capture.onChunk?.(new Float32Array(frames * OWW_FRAME_SAMPLES).fill(0.01));
}

describe('WakeWordListener motor oww', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exige opts.oww con engine oww', () => {
    expect(() => new WakeWordListener({ word: 'chochi', engine: 'oww' })).toThrow(/opts\.oww/);
  });

  it('sigue en whisper por defecto (sin opts.oww no rompe)', () => {
    const l = new WakeWordListener({ word: 'chochi', transcriber: async () => 'nada' });
    expect(l.isRunning()).toBe(false);
  });

  it('dispara onWake con la palabra cuando el score supera el umbral', async () => {
    const capture = new FakeCapture();
    const wakes: string[] = [];
    // Primer score en el push 25; scores bajos y uno alto en la llamada 4 del clasificador (push 28).
    const listener = makeListener({
      scoreScript: [0.05, 0.05, 0.05, 0.9, 0.05],
      wakes,
      capture,
    });
    await listener.start();
    pushFrames(capture, 40);
    await waitFor(() => wakes.length === 1, 2_000);
    expect(wakes[0]).toBe('chochi');
    expect(listener.stats().wakeCount).toBe(1);
    await listener.stop();
  });

  it('no dispara por debajo del umbral', async () => {
    const capture = new FakeCapture();
    const wakes: string[] = [];
    const listener = makeListener({ scoreScript: [0.4, 0.4, 0.4, 0.4], wakes, capture });
    await listener.start();
    pushFrames(capture, 35);
    await wait(300);
    expect(wakes).toEqual([]);
    expect(listener.stats().wakeCount).toBe(0);
    await listener.stop();
  });

  it('un score alto durante suppression no despierta', async () => {
    const capture = new FakeCapture();
    const wakes: string[] = [];
    const listener = makeListener({ scoreScript: [0.95], wakes, capture });
    await listener.start();
    listener.suppress(5_000);
    pushFrames(capture, 40);
    await wait(400);
    expect(wakes).toEqual([]);
    await listener.stop();
  });

  it('un score alto en hold (sesion duena del micro) no despierta', async () => {
    const capture = new FakeCapture();
    const wakes: string[] = [];
    const listener = makeListener({ scoreScript: [0.95], wakes, capture });
    await listener.start();
    listener.hold(true);
    pushFrames(capture, 40);
    await wait(400);
    expect(wakes).toEqual([]);
    await listener.stop();
  });

  it('stop() cierra el detector: pushFrame posterior esta cerrado', async () => {
    const capture = new FakeCapture();
    const wakes: string[] = [];
    const { sessions } = fakeSessions([0.05]);
    const detector = OwwWakeDetector.overSessions(sessions);
    const listener = new WakeWordListener({
      word: 'chochi',
      engine: 'oww',
      oww: { modelDir: '/no/importa', wordModelFile: 'chochi.onnx', detector },
      capture,
      onWake: (h) => {
        wakes.push(h);
      },
    });
    await listener.start();
    pushFrames(capture, 5);
    await listener.stop();
    await expect(detector.pushFrame(new Float32Array(OWW_FRAME_SAMPLES))).rejects.toThrow(
      /cerrado/,
    );
    expect(capture.stopCalls).toBe(1);
    expect(wakes).toEqual([]);
  });

  it('un fallo al crear el detector llega con la ruta de entrenamiento', async () => {
    const capture = new FakeCapture();
    const listener = new WakeWordListener({
      word: 'chochi',
      engine: 'oww',
      // Nombre invalido: ensureOwwModels lo rechaza ANTES de mkdir o de
      // descargar nada, asi el test no toca red ni el sistema de ficheros.
      oww: { modelDir: '/no/importa', wordModelFile: '../chochi.onnx' },
      capture,
    });
    await expect(listener.start()).rejects.toThrow(/wakeword-train\.py/);
    expect(listener.isRunning()).toBe(false);
  });
});

describe('config voiceWake', () => {
  afterEach(() => {
    delete process.env.PA_WAKE_ENGINE;
    delete process.env.PA_WAKE_OWW_MODEL;
    delete process.env.PA_WAKE_OWW_THRESHOLD;
    resetConfigForTests();
  });

  it('whisper es el motor por defecto', () => {
    expect(loadConfig().voiceWake).toEqual({ engine: 'whisper', owwModel: '', owwThreshold: 0.5 });
  });

  it('rechaza un motor desconocido', () => {
    process.env.PA_WAKE_ENGINE = 'otro';
    expect(() => loadConfig()).toThrow(/PA_WAKE_ENGINE/);
  });

  it('oww exige un nombre .onnx simple', () => {
    process.env.PA_WAKE_ENGINE = 'oww';
    expect(() => loadConfig()).toThrow(/PA_WAKE_OWW_MODEL/);
    resetConfigForTests();
    process.env.PA_WAKE_OWW_MODEL = '../chochi.onnx';
    expect(() => loadConfig()).toThrow(/PA_WAKE_OWW_MODEL/);
    resetConfigForTests();
    process.env.PA_WAKE_OWW_MODEL = 'chochi.onnx';
    expect(loadConfig().voiceWake.engine).toBe('oww');
    expect(loadConfig().voiceWake.owwModel).toBe('chochi.onnx');
  });

  it('valida el umbral entre 0 y 1', () => {
    process.env.PA_WAKE_OWW_THRESHOLD = '1.5';
    expect(() => loadConfig()).toThrow(/PA_WAKE_OWW_THRESHOLD/);
    resetConfigForTests();
    process.env.PA_WAKE_OWW_THRESHOLD = '0.7';
    expect(loadConfig().voiceWake.owwThreshold).toBe(0.7);
  });
});
