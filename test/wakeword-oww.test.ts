// Item A1a ronda 2 (auditor #138): el runner replica el pipeline OFICIAL
// openwakeword v0.5.1 (utils.py verificado): PCM int16 en float32 sin
// normalizar, lookback de 480 muestras -> 8 frames mel por push (5 en el
// primero), transform spec/10+2, ventanas 76/16. Sesiones falsas con la
// LOGICA DE FORMAS oficial, no con formas inventadas. La paridad numerica
// contra el Python oficial la prueban scripts/wakeword-parity.* (opt-in).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureOwwModels,
  floatToInt16Scale,
  melTransform,
  OWW_EMB_SIZE,
  OWW_EMB_WINDOW,
  OWW_FIRST_SCORE_FRAME,
  OWW_FRAME_SAMPLES,
  OWW_MEL_BINS,
  OWW_MEL_LOOKBACK,
  OWW_MEL_WINDOW,
  type OwwSession,
  OwwWakeDetector,
} from '../src/voice/wakeword-oww.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

/** Frame con contenido reconocible: rampa 0..1. */
function rampFrame(): Float32Array {
  const out = new Float32Array(OWW_FRAME_SAMPLES);
  for (let i = 0; i < out.length; i++) out[i] = i / OWW_FRAME_SAMPLES;
  return out;
}

/** Frames mel que produce el modelo oficial para N muestras de entrada. */
const officialMelFrames = (samples: number) => Math.floor((samples - OWW_MEL_LOOKBACK) / 160);

function fakeSessions() {
  const calls = { melspec: 0, embedding: 0, classifier: 0 };
  const released: string[] = [];
  const melInputs: { len: number; head: number[]; tail: number[] }[] = [];
  const embFirstValue: number[] = [];
  const clsFirstEmb: number[] = [];
  const MEL_CONST = 12;
  const melspec: OwwSession = {
    inputNames: ['input'],
    outputNames: ['output'],
    run: async (feeds) => {
      calls.melspec++;
      const t = feeds.input;
      const len = t?.dims[1] ?? 0;
      melInputs.push({
        len,
        head: [...(t?.data.slice(0, 4) ?? [])],
        tail: [...(t?.data.slice(-4) ?? [])],
      });
      const frames = officialMelFrames(len);
      return {
        output: {
          data: new Float32Array(frames * OWW_MEL_BINS).fill(MEL_CONST),
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
      calls.embedding++;
      const t = feeds.input_1;
      if (t?.data.length !== OWW_MEL_WINDOW * OWW_MEL_BINS) throw new Error('ventana mel mal');
      embFirstValue.push(t?.data[0] ?? -1);
      const vec = new Float32Array(OWW_EMB_SIZE);
      vec[0] = calls.embedding; // marca de llamada para rastrear la ventana
      return { conv2d_19: { data: vec, dims: [1, 1, 1, OWW_EMB_SIZE] } };
    },
    release: async () => {
      released.push('embedding');
    },
  };
  const classifier: OwwSession = {
    inputNames: ['x.1'],
    outputNames: ['53'],
    run: async (feeds) => {
      calls.classifier++;
      const t = feeds['x.1'];
      if (t?.data.length !== OWW_EMB_WINDOW * OWW_EMB_SIZE) throw new Error('ventana emb mal');
      clsFirstEmb.push(t?.data[0] ?? -1);
      return { 53: { data: new Float32Array([0.01]), dims: [1, 1] } };
    },
    release: async () => {
      released.push('classifier');
    },
  };
  return {
    sessions: { melspec, embedding, classifier },
    calls,
    released,
    melInputs,
    embFirstValue,
    clsFirstEmb,
    MEL_CONST,
  };
}

describe('A1a r2: fidelidad al pipeline oficial (frames, escala, lookback, transform)', () => {
  it('push 1 alimenta [1,1280] (5 frames mel) y push 2+ [1,1760] (8 frames), como utils.py', async () => {
    const { sessions, melInputs } = fakeSessions();
    const det = OwwWakeDetector.overSessions(sessions);
    await det.pushFrame(rampFrame());
    await det.pushFrame(rampFrame());
    await det.pushFrame(rampFrame());
    expect(melInputs[0]?.len).toBe(OWW_FRAME_SAMPLES);
    expect(melInputs[1]?.len).toBe(OWW_FRAME_SAMPLES + OWW_MEL_LOOKBACK);
    expect(melInputs[2]?.len).toBe(OWW_FRAME_SAMPLES + OWW_MEL_LOOKBACK);
    expect(officialMelFrames(OWW_FRAME_SAMPLES)).toBe(5);
    expect(officialMelFrames(OWW_FRAME_SAMPLES + OWW_MEL_LOOKBACK)).toBe(8);
  });

  it('el lookback de push 2 son las ultimas 480 muestras de push 1, en escala int16', async () => {
    const { sessions, melInputs } = fakeSessions();
    const det = OwwWakeDetector.overSessions(sessions);
    const f1 = rampFrame();
    await det.pushFrame(f1);
    await det.pushFrame(rampFrame());
    const head = melInputs[1]?.head ?? [];
    for (let i = 0; i < 4; i++) {
      expect(head[i]).toBe(floatToInt16Scale(f1[OWW_FRAME_SAMPLES - OWW_MEL_LOOKBACK + i] ?? 0));
    }
  });

  it('escala oficial: float [-1,1] -> int16 como float32, SIN normalizar', async () => {
    const { sessions, melInputs } = fakeSessions();
    const det = OwwWakeDetector.overSessions(sessions);
    const f = new Float32Array(OWW_FRAME_SAMPLES);
    f[0] = -1;
    f[1] = 0.5;
    f[2] = 1;
    await det.pushFrame(f);
    const head = melInputs[0]?.head ?? [];
    expect(head[0]).toBe(-32767);
    expect(head[1]).toBe(16384);
    expect(head[2]).toBe(32767);
  });

  it('transform oficial spec/10+2 aplicada a cada frame mel antes del embedding', async () => {
    const { sessions, embFirstValue, MEL_CONST } = fakeSessions();
    const det = OwwWakeDetector.overSessions(sessions);
    for (let i = 0; i < 10; i++) await det.pushFrame(rampFrame());
    expect(embFirstValue.length).toBe(1); // ventana mel llena en el push 10
    expect(embFirstValue[0]).toBeCloseTo(melTransform(MEL_CONST), 5);
    expect(melTransform(MEL_CONST)).toBeCloseTo(3.2, 5);
  });

  it('warmup oficial: ventana mel llena en push 10, primer score en push 25', async () => {
    const { sessions, calls } = fakeSessions();
    const det = OwwWakeDetector.overSessions(sessions);
    expect(OWW_FIRST_SCORE_FRAME).toBe(25);
    for (let i = 1; i <= 24; i++) {
      expect(await det.pushFrame(rampFrame())).toBeNull();
    }
    expect(calls.melspec).toBe(24);
    expect(calls.embedding).toBe(15); // pushes 10..24
    expect(calls.classifier).toBe(0);
    const score = await det.pushFrame(rampFrame());
    expect(score).toBeCloseTo(0.01, 6);
    expect(calls.embedding).toBe(16);
    expect(calls.classifier).toBe(1);
  });

  it('las ventanas deslizan: el clasificador del push N ve embeddings de N-15..N', async () => {
    const { sessions, clsFirstEmb } = fakeSessions();
    const det = OwwWakeDetector.overSessions(sessions);
    for (let i = 1; i <= 26; i++) await det.pushFrame(rampFrame());
    expect(clsFirstEmb[0]).toBe(1); // embeddings de pushes 10..25 (marcas 1..16)
    expect(clsFirstEmb[1]).toBe(2); // pushes 11..26 (marcas 2..17)
  });

  it('reset() vuelve al estado inicial: sin carry ni ventanas', async () => {
    const { sessions, melInputs } = fakeSessions();
    const det = OwwWakeDetector.overSessions(sessions);
    await det.pushFrame(rampFrame());
    await det.pushFrame(rampFrame());
    det.reset();
    expect(await det.pushFrame(rampFrame())).toBeNull();
    expect(melInputs[2]?.len).toBe(OWW_FRAME_SAMPLES); // sin lookback tras reset
  });

  it('rechaza frames de longitud incorrecta', async () => {
    const { sessions } = fakeSessions();
    const det = OwwWakeDetector.overSessions(sessions);
    await expect(det.pushFrame(new Float32Array(100))).rejects.toThrow(/1280/);
  });

  it('close() libera las tres sesiones una vez y bloquea pushes posteriores', async () => {
    const { sessions, released } = fakeSessions();
    const det = OwwWakeDetector.overSessions(sessions);
    await det.close();
    await det.close();
    expect(released.sort()).toEqual(['classifier', 'embedding', 'melspec']);
    await expect(det.pushFrame(rampFrame())).rejects.toThrow(/cerrado/);
  });
});

describe('A1a r2: create() no pierde sesiones abiertas si una factory falla', () => {
  it('la segunda factory rechaza: la primera sesion se libera y el error propaga', async () => {
    const released: string[] = [];
    const made: string[] = [];
    const mk = (name: string) => async () => {
      made.push(name);
      return {
        inputNames: ['i'],
        outputNames: ['o'],
        run: async () => ({}),
        release: async () => {
          released.push(name);
        },
      } as OwwSession;
    };
    const dir = mkdtempSync(join(tmpdir(), 'oww-c-'));
    for (const f of ['melspectrogram.onnx', 'embedding_model.onnx', 'w.onnx']) {
      writeFileSync(join(dir, f), Buffer.alloc(200_000));
    }
    let n = 0;
    const factory = async (path: string) => {
      n++;
      if (n === 2) throw new Error('embedding roto');
      return mk(path)();
    };
    await expect(
      OwwWakeDetector.create({ modelDir: dir, wordModelFile: 'w.onnx', factory }),
    ).rejects.toThrow(/embedding roto/);
    expect(made).toHaveLength(1);
    expect(released).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('A1a r2: ensureOwwModels (descarga honesta y segura)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  const bigBody = () => new ArrayBuffer(200_000);

  it('rechaza wordModelFile con path (../, sub/dir, sin .onnx)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oww-'));
    for (const bad of ['../evil.onnx', 'sub/dir.onnx', 'sin-extension', 'a/../b.onnx']) {
      await expect(ensureOwwModels(dir, bad, vi.fn() as never)).rejects.toThrow(/simple/);
    }
  });

  it('descargas concurrentes del mismo modelo no colisionan (tmp unico wx)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oww-'));
    const fakeFetch = async () => new Response(bigBody(), { status: 200 });
    const [a, b] = await Promise.all([
      ensureOwwModels(dir, 'w.onnx', fakeFetch as typeof fetch),
      ensureOwwModels(dir, 'w.onnx', fakeFetch as typeof fetch),
    ]);
    expect(readFileSync(a.classifier).byteLength).toBe(200_000);
    expect(readFileSync(b.classifier).byteLength).toBe(200_000);
  });

  it('no vuelve a descargar lo que ya existe', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oww-'));
    for (const f of ['melspectrogram.onnx', 'embedding_model.onnx', 'w.onnx']) {
      writeFileSync(join(dir, f), Buffer.alloc(200_000));
    }
    const fakeFetch = vi.fn();
    await ensureOwwModels(dir, 'w.onnx', fakeFetch as unknown as typeof fetch);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('una respuesta minuscula (pagina 404) es error, no un modelo', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oww-'));
    const fakeFetch = async () => new Response(new ArrayBuffer(14), { status: 200 });
    await expect(ensureOwwModels(dir, 'w.onnx', fakeFetch as typeof fetch)).rejects.toThrow(
      /pequeña/,
    );
  });
});
