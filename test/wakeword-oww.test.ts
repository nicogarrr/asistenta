// Item A1a (wake word openWakeWord): tests escritos ANTES de la implementacion.
// El runner ONNX se prueba con sesiones FALSAS inyectadas (misma costura que
// wake.ts con whisper): la matriz de frames/ventanas se verifica en
// milisegundos, sin descargas ni ONNX real. El modelo real lo ejercita el
// bench (scripts/wakeword-bench.ts) y un test de integracion opt-in.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureOwwModels,
  OWW_EMB_SIZE,
  OWW_EMB_WINDOW,
  OWW_FIRST_SCORE_FRAME,
  OWW_FRAME_SAMPLES,
  OWW_MEL_BINS,
  OWW_MEL_FRAMES_PER_PASS,
  OWW_MEL_WINDOW,
  type OwwSession,
  OwwWakeDetector,
} from '../src/voice/wakeword-oww.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const FRAME = new Float32Array(OWW_FRAME_SAMPLES);

/**
 * Sesiones falsas deterministas. El embedding codifica su numero de llamada
 * en la primera componente para poder rastrear QUE embeddings ve el
 * clasificador; el clasificador devuelve la media de su entrada, asi el
 * score esperado se calcula a mano.
 */
function fakeSessions() {
  const calls = { melspec: 0, embedding: 0, classifier: 0 };
  const released: string[] = [];
  const clsInputs: { dims: readonly number[]; firstEmb: number }[] = [];
  const melInputs: number[][] = [];
  const embInputs: number[][] = [];
  const melspec: OwwSession = {
    inputNames: ['input'],
    outputNames: ['output'],
    run: async (feeds) => {
      calls.melspec++;
      const t = feeds.input;
      melInputs.push([...(t?.dims ?? [])]);
      if (t?.data.length !== OWW_FRAME_SAMPLES) throw new Error('frame mal cortado');
      return {
        output: {
          data: new Float32Array(OWW_MEL_FRAMES_PER_PASS * OWW_MEL_BINS),
          dims: [1, 1, OWW_MEL_FRAMES_PER_PASS, OWW_MEL_BINS],
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
      embInputs.push([...(t?.dims ?? [])]);
      if (t?.data.length !== OWW_MEL_WINDOW * OWW_MEL_BINS) throw new Error('ventana mel mal');
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
      clsInputs.push({ dims: t?.dims ?? [], firstEmb: t?.data[0] ?? -1 });
      if (t?.data.length !== OWW_EMB_WINDOW * OWW_EMB_SIZE) throw new Error('ventana emb mal');
      let sum = 0;
      for (const v of t?.data ?? []) sum += v;
      return {
        '53': { data: new Float32Array([sum / (OWW_EMB_WINDOW * OWW_EMB_SIZE)]), dims: [1, 1] },
      };
    },
    release: async () => {
      released.push('classifier');
    },
  };
  return {
    sessions: { melspec, embedding, classifier },
    calls,
    released,
    clsInputs,
    melInputs,
    embInputs,
  };
}

describe('A1a: OwwWakeDetector (matriz de frames, sesiones falsas)', () => {
  it('sin score durante el warmup (30 frames) y primer score en el frame 31', async () => {
    const { sessions } = fakeSessions();
    const det = OwwWakeDetector.overSessions(sessions);
    expect(det.warmupFrames).toBe(OWW_FIRST_SCORE_FRAME);
    expect(OWW_FIRST_SCORE_FRAME).toBe(31);
    for (let i = 1; i <= 30; i++) {
      expect(await det.pushFrame(FRAME)).toBeNull();
    }
    const score = await det.pushFrame(FRAME);
    expect(typeof score).toBe('number');
  });

  it('tras el warmup cada frame devuelve score; el melspec corre 1 vez por frame', async () => {
    const { sessions, calls } = fakeSessions();
    const det = OwwWakeDetector.overSessions(sessions);
    for (let i = 1; i <= 31; i++) await det.pushFrame(FRAME);
    expect(calls.melspec).toBe(31);
    expect(calls.embedding).toBe(16); // una por push desde que la ventana mel se lleno
    expect(calls.classifier).toBe(1);
    const a = await det.pushFrame(FRAME);
    const b = await det.pushFrame(FRAME);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(calls.classifier).toBe(3);
  });

  it('las ventanas deslizan: el clasificador del push N ve embeddings de N-15..N', async () => {
    const { sessions, clsInputs } = fakeSessions();
    const det = OwwWakeDetector.overSessions(sessions);
    for (let i = 1; i <= 31; i++) await det.pushFrame(FRAME);
    // Primer score: embeddings de los pushes 16..31 (el primero llega en el
    // push 16, cuando la ventana mel llega a 76). Sus marcas: 1..16.
    expect(clsInputs[0]?.dims).toEqual([1, OWW_EMB_WINDOW, OWW_EMB_SIZE]);
    expect(clsInputs[0]?.firstEmb).toBe(1);
    await det.pushFrame(FRAME); // push 32 -> embeddings 17..32, marcas 2..17
    expect(clsInputs[1]?.firstEmb).toBe(2);
    // La forma de cada llamada es la oficial del pipeline.
  });

  it('formas ONNX oficiales: melspec [1,1280], embedding [1,76,32,1], clasificador [1,16,96]', async () => {
    const { sessions, melInputs, embInputs, clsInputs } = fakeSessions();
    const det = OwwWakeDetector.overSessions(sessions);
    for (let i = 1; i <= 31; i++) await det.pushFrame(FRAME);
    expect(melInputs[0]).toEqual([1, OWW_FRAME_SAMPLES]);
    expect(embInputs[0]).toEqual([1, OWW_MEL_WINDOW, OWW_MEL_BINS, 1]);
    expect(clsInputs[0]?.dims).toEqual([1, OWW_EMB_WINDOW, OWW_EMB_SIZE]);
  });

  it('rechaza frames de longitud incorrecta en vez de inferir sobre audio corrupto', async () => {
    const { sessions } = fakeSessions();
    const det = OwwWakeDetector.overSessions(sessions);
    await expect(det.pushFrame(new Float32Array(100))).rejects.toThrow(/1280/);
    await expect(det.pushFrame(new Float32Array(0))).rejects.toThrow(/1280/);
  });

  it('reset() vacia las ventanas: vuelve el warmup', async () => {
    const { sessions } = fakeSessions();
    const det = OwwWakeDetector.overSessions(sessions);
    for (let i = 1; i <= 31; i++) await det.pushFrame(FRAME);
    det.reset();
    expect(await det.pushFrame(FRAME)).toBeNull();
  });

  it('close() libera las tres sesiones una vez y bloquea pushes posteriores', async () => {
    const { sessions, released } = fakeSessions();
    const det = OwwWakeDetector.overSessions(sessions);
    await det.close();
    await det.close();
    expect(released.sort()).toEqual(['classifier', 'embedding', 'melspec']);
    await expect(det.pushFrame(FRAME)).rejects.toThrow(/cerrado/);
  });
});

describe('A1a: ensureOwwModels (descarga honesta)', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  const bigBody = () => new ArrayBuffer(200_000);

  it('descarga los 3 modelos (features + palabra) via tmp+rename', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oww-'));
    const seen: string[] = [];
    const fakeFetch = async (url: string | URL) => {
      seen.push(String(url));
      return new Response(bigBody(), { status: 200 });
    };
    const paths = await ensureOwwModels(dir, 'hey_jarvis_v0.1.onnx', fakeFetch as typeof fetch);
    expect(seen).toHaveLength(3);
    for (const p of Object.values(paths)) {
      expect(readFileSync(p).byteLength).toBe(200_000);
    }
    expect(paths.classifier).toContain('hey_jarvis_v0.1.onnx');
  });

  it('no vuelve a descargar lo que ya existe', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oww-'));
    for (const f of ['melspectrogram.onnx', 'embedding_model.onnx', 'hey_jarvis_v0.1.onnx']) {
      writeFileSync(join(dir, f), Buffer.alloc(200_000));
    }
    const fakeFetch = vi.fn();
    await ensureOwwModels(dir, 'hey_jarvis_v0.1.onnx', fakeFetch as unknown as typeof fetch);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('una respuesta minuscula (pagina 404) es error, no un modelo', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oww-'));
    const fakeFetch = async () => new Response(new ArrayBuffer(14), { status: 200 });
    await expect(
      ensureOwwModels(dir, 'hey_jarvis_v0.1.onnx', fakeFetch as typeof fetch),
    ).rejects.toThrow(/pequeña/);
    // Y no queda ni el .partial ni un modelo truncado.
    expect(readFileSyncSafe(join(dir, 'melspectrogram.onnx'))).toBeNull();
    expect(readFileSyncSafe(join(dir, 'melspectrogram.onnx.partial'))).toBeNull();
  });

  it('un HTTP error es error explicito con el status', async () => {
    dir = mkdtempSync(join(tmpdir(), 'oww-'));
    const fakeFetch = async () => new Response(null, { status: 503 });
    await expect(
      ensureOwwModels(dir, 'hey_jarvis_v0.1.onnx', fakeFetch as typeof fetch),
    ).rejects.toThrow(/503/);
  });
});

function readFileSyncSafe(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}
