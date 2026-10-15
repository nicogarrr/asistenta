// Item A5 (infra): SileroVad replica el contrato del modelo oficial v4.0
// (inspeccionado del .onnx): input [1,512] float32, sr int64 escalar,
// h/c [2,1,64] llevados entre ventanas; outputs output/hn/cn. Las sesiones
// falsas implementan la LOGICA DE FORMAS oficial, no formas inventadas.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureVadModel,
  SileroVad,
  VAD_MODEL_SHA256,
  VAD_STATE_DIM,
  VAD_WINDOW_SAMPLES,
  type VadSession,
} from '../src/voice/vad-silero.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

/** Payload binario mínimo que supera el corte de tamaño (100 KB). */
const FAKE_MODEL = Buffer.alloc(120_000, 7);
const FAKE_MODEL_SHA = createHash('sha256').update(FAKE_MODEL).digest('hex');

function frame(v = 0.5): Float32Array {
  return new Float32Array(VAD_WINDOW_SAMPLES).fill(v);
}

interface FakeVad extends VadSession {
  runs: number;
  lastFeeds: Record<string, { data: Float32Array | BigInt64Array; dims: readonly number[] }> | undefined;
  probs: number[];
  released: boolean;
  failRelease: boolean;
}

/** Sesión falsa con la semántica oficial: estado entra y sale, prob de una cola. */
function fakeVad(probs: number[] = [0.9]): FakeVad {
  const st: FakeVad = {
    runs: 0,
    lastFeeds: undefined,
    probs,
    released: false,
    failRelease: false,
    inputNames: ['input', 'sr', 'h', 'c'],
    outputNames: ['output', 'hn', 'cn'],
    run: async (feeds) => {
      st.runs++;
      st.lastFeeds = feeds;
      const inp = feeds.input;
      if (!inp || inp.dims[1] !== VAD_WINDOW_SAMPLES) throw new Error('ventana vad mal');
      const h = feeds.h;
      if (!h || h.dims.join(',') !== `2,1,${VAD_STATE_DIM}`) throw new Error('estado h mal');
      // hn lleva la marca del nº de run para rastrear que el estado se encadena.
      const hn = new Float32Array(2 * VAD_STATE_DIM).fill(st.runs);
      const cn = new Float32Array(2 * VAD_STATE_DIM).fill(-st.runs);
      const p = st.probs.length > 1 ? st.probs.shift()! : st.probs[0]!;
      return {
        output: { data: new Float32Array([p]), dims: [1, 1] },
        hn: { data: hn, dims: [2, 1, VAD_STATE_DIM] },
        cn: { data: cn, dims: [2, 1, VAD_STATE_DIM] },
      };
    },
    release: async () => {
      if (st.failRelease) throw new Error('release falló');
      st.released = true;
    },
  };
  return st;
}

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('A5: contrato del modelo oficial (ventana 512, sr int64, estado LSTM)', () => {
  it('cada push alimenta [1,512] con sr=16000 int64 y h/c [2,1,64], y devuelve la prob', async () => {
    const s = fakeVad([0.42]);
    const vad = SileroVad.overSession(s);
    const p = await vad.pushFrame(frame());
    expect(p).toBeCloseTo(0.42, 6);
    expect(s.lastFeeds?.input?.dims).toEqual([1, VAD_WINDOW_SAMPLES]);
    expect(s.lastFeeds?.sr?.data).toBeInstanceOf(BigInt64Array);
    expect(s.lastFeeds?.sr?.data[0]).toBe(16000n);
    expect(s.lastFeeds?.h?.dims).toEqual([2, 1, VAD_STATE_DIM]);
  });

  it('el estado devuelto por el run N alimenta el run N+1', async () => {
    const s = fakeVad([0.1, 0.2, 0.3]);
    const vad = SileroVad.overSession(s);
    await vad.pushFrame(frame());
    await vad.pushFrame(frame());
    await vad.pushFrame(frame());
    // En el 3er run, h es el hn del run 2 (marca 2).
    expect(s.lastFeeds?.h?.data[0]).toBe(2);
    expect(s.lastFeeds?.c?.data[0]).toBe(-2);
  });

  it('rechaza frames de longitud distinta a 512', async () => {
    const vad = SileroVad.overSession(fakeVad());
    await expect(vad.pushFrame(new Float32Array(1280))).rejects.toThrow('512');
  });
});

describe('A5: reset invalida estado y audio pre-reset (generación)', () => {
  it('reset() devuelve h/c a ceros en el siguiente run', async () => {
    const s = fakeVad([0.9]);
    const vad = SileroVad.overSession(s);
    await vad.pushFrame(frame());
    vad.reset();
    await vad.pushFrame(frame());
    expect(s.lastFeeds?.h?.data.every((v) => v === 0)).toBe(true);
  });

  it('todo push recibido antes de reset() (activo o encolado) descarta: -1 sin tocar el modelo', async () => {
    const s = fakeVad([0.9]);
    // Bloquear el primer run para que el segundo quede encolado pre-reset.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const baseRun = s.run;
    let first = true;
    s.run = async (feeds) => {
      if (first) {
        first = false;
        await gate;
      }
      return baseRun(feeds);
    };
    const vad = SileroVad.overSession(s);
    // reset() SINCRONO antes de que la cadena arranque: ambos pushes son
    // audio pre-reset (la generación se captura al encolar) y descartan.
    const p1 = vad.pushFrame(frame());
    const p2 = vad.pushFrame(frame());
    vad.reset();
    release();
    expect(await p1).toBe(-1);
    expect(await p2).toBe(-1);
    expect(s.runs).toBe(0); // ninguno corrió contra el modelo
    // Un push POSTERIOR al reset corre con estado limpio.
    expect(await vad.pushFrame(frame())).toBeCloseTo(0.9, 6);
    expect(s.lastFeeds?.h?.data.every((v) => v === 0)).toBe(true);
  });

  it('un reset DURANTE el await del run descarta el resultado (-1) y no repuebla estado', async () => {
    const s = fakeVad([0.9]);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const baseRun = s.run;
    s.run = async (feeds) => {
      const out = await baseRun(feeds);
      await gate; // el run terminó; el await extra deja hueco al reset
      return out;
    };
    const vad = SileroVad.overSession(s);
    const p1 = vad.pushFrame(frame());
    await new Promise((r) => setImmediate(r)); // deja entrar al run
    vad.reset();
    release();
    expect(await p1).toBe(-1);
    // El estado interno quedó en ceros: el siguiente push alimenta h=0.
    expect(await vad.pushFrame(frame())).toBeCloseTo(0.9, 6);
    expect(s.lastFeeds?.h?.data.every((v) => v === 0)).toBe(true);
  });
});

describe('A5: close drena la cadena y libera una sola vez, con reintento', () => {
  it('close() espera al push en curso antes de liberar', async () => {
    const s = fakeVad([0.7]);
    const vad = SileroVad.overSession(s);
    await vad.pushFrame(frame());
    await vad.close();
    expect(s.released).toBe(true);
    await expect(vad.pushFrame(frame())).rejects.toThrow('cerrado');
  });

  it('un release fallido se reintenta en el siguiente close()', async () => {
    const s = fakeVad();
    s.failRelease = true;
    const vad = SileroVad.overSession(s);
    await expect(vad.close()).rejects.toThrow('release');
    s.failRelease = false;
    await vad.close();
    expect(s.released).toBe(true);
  });
});

describe('A5: ensureVadModel (descarga con wx+rename y sha256 verificado)', () => {
  const fetchOk = (buf: Buffer) => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(new Uint8Array(buf), { status: 200 });
    }) as unknown as typeof fetch;
    return { f, calls: () => calls };
  };

  it('descarga, verifica sha256 y deja el modelo en sitio; la 2ª llamada reutiliza', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vad-'));
    const { f, calls } = fetchOk(FAKE_MODEL);
    const p = await ensureVadModel(dir, f, FAKE_MODEL_SHA);
    expect(readFileSync(p).equals(FAKE_MODEL)).toBe(true);
    await ensureVadModel(dir, f, FAKE_MODEL_SHA);
    expect(calls()).toBe(1);
  });

  it('rechaza contenido con sha256 distinto al esperado', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vad-'));
    const { f } = fetchOk(FAKE_MODEL);
    await expect(ensureVadModel(dir, f)).rejects.toThrow('sha256');
  });

  it('rechaza descargas pequeñas (¿404?)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vad-'));
    const { f } = fetchOk(Buffer.alloc(500));
    await expect(ensureVadModel(dir, f)).rejects.toThrow('pequeña');
  });

  it('rechaza HTTP no-ok', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vad-'));
    const f = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(ensureVadModel(dir, f)).rejects.toThrow('404');
  });

  it('un fichero presente con sha distinto se redescarga, no se reutiliza', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vad-'));
    writeFileSync(join(dir, 'silero_vad.onnx'), Buffer.alloc(150_000, 9));
    const { f, calls } = fetchOk(FAKE_MODEL);
    const p = await ensureVadModel(dir, f, FAKE_MODEL_SHA);
    expect(readFileSync(p).equals(FAKE_MODEL)).toBe(true);
    expect(calls()).toBe(1);
    expect(VAD_MODEL_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});
