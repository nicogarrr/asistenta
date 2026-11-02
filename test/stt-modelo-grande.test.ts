import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sin modelo ni red: un whisper falso por checkpoint, que deja ver cuál transcribe.
const st = vi.hoisted(() => ({
  loads: [] as string[],
  failLoad: new Set<string>(),
  holdLoad: null as null | Promise<void>,
}));

vi.mock('../src/voice/decode.js', () => ({
  decodeForWhisper: async () => ({
    samples: Float32Array.from({ length: 32_000 }, (_, i) => 0.3 * Math.sin(i / 5)),
    sampleRate: 16_000,
  }),
}));

vi.mock('@huggingface/transformers', () => ({
  LogLevel: { ERROR: 40 },
  env: {},
  pipeline: async (_task: string, model: string) => {
    st.loads.push(model);
    if (st.holdLoad) await st.holdLoad;
    if (st.failLoad.has(model)) throw new Error('Protobuf parsing failed');
    const name = model.includes('turbo') ? 'turbo' : 'small';
    const pipe = async () => ({ text: ` oído por ${name}` });
    return Object.assign(pipe, {
      processor: async () => ({ input_features: {} }),
      tokenizer: {
        convert_tokens_to_ids: (t: string) =>
          ({ '<|startofprev|>': 1, '<|notimestamps|>': 50363 })[t] ?? 2,
        encode: () => [10],
        decode: () => `oído por ${name}`,
      },
      model: {
        generate: async (args: {
          decoder_input_ids: number[];
          logits_processor?: Array<(i: unknown, l: { data: Float32Array }) => unknown>;
        }) => {
          for (const p of args.logits_processor ?? []) p([], { data: Float32Array.from([9, 0]) });
          return { tolist: () => [[...args.decoder_input_ids, 100]] };
        },
      },
    });
  },
}));

import {
  resetSttStateForTests,
  SMALL_STT_MODEL,
  STT_DOWNLOAD_NOTICE,
  sttModelFromEnv,
  TURBO_STT_MODEL,
  transcribeVoiceNote,
} from '../src/voice/stt.js';

const GB = 1024 ** 3;
const nota = Buffer.from('OggS falso');
const big = { env: {}, totalMem: 16 * GB };

beforeEach(() => {
  resetSttStateForTests();
  st.loads.length = 0;
  st.failLoad.clear();
  st.holdLoad = null;
});

describe('notas de voz: el modelo grande (large-v3-turbo) por defecto, small de respaldo', () => {
  it('sin elegir nada, turbo; PA_STT_MODEL=small lo cambia; con poca RAM, small', () => {
    expect(sttModelFromEnv({}, 16 * GB)).toBe(TURBO_STT_MODEL);
    expect(sttModelFromEnv({ PA_STT_MODEL: 'small' }, 16 * GB)).toBe(SMALL_STT_MODEL);
    expect(sttModelFromEnv({ PA_STT_MODEL: ' Turbo ' }, 4 * GB)).toBe(TURBO_STT_MODEL);
    expect(sttModelFromEnv({}, 4 * GB)).toBe(SMALL_STT_MODEL);
    expect(sttModelFromEnv({ PA_STT_MODEL: 'enorme' }, 16 * GB)).toBe(TURBO_STT_MODEL);
  });

  it('turbo ya descargado: la nota va con turbo y sin avisos', async () => {
    const r = await transcribeVoiceNote(nota, {}, { ...big, isCached: () => true });
    expect(r.text).toBe('oído por turbo');
    expect(r.notice).toBeUndefined();
    expect(st.loads).toEqual([TURBO_STT_MODEL]);
  });

  it('turbo sin descargar: esta nota va con small, turbo se baja en segundo plano y se avisa una vez', async () => {
    let release = () => {};
    st.holdLoad = new Promise<void>((r) => {
      release = r;
    });
    const first = transcribeVoiceNote(nota, {}, { ...big, isCached: () => false });
    await vi.waitFor(() => expect(st.loads).toContain(SMALL_STT_MODEL));
    expect(st.loads).toContain(TURBO_STT_MODEL);
    release();
    st.holdLoad = null;
    const r1 = await first;
    expect(r1.text).toBe('oído por small');
    expect(r1.notice).toBe(STT_DOWNLOAD_NOTICE);
    expect(STT_DOWNLOAD_NOTICE).toMatch(/Descargando el modelo de voz/);
    // Ya bajado y cargado: la siguiente va con turbo, sin repetir el aviso ni la descarga.
    await vi.waitFor(async () => {
      const r2 = await transcribeVoiceNote(nota, {}, { ...big, isCached: () => false });
      expect(r2.text).toBe('oído por turbo');
      expect(r2.notice).toBeUndefined();
    });
    expect(st.loads.filter((m) => m === TURBO_STT_MODEL)).toHaveLength(1);
  });

  it('si la descarga de turbo falla, siguen con small y no se reintenta en 10 min', async () => {
    st.failLoad.add(TURBO_STT_MODEL);
    let now = 1_000_000;
    const deps = { ...big, isCached: () => false, now: () => now };
    const r1 = await transcribeVoiceNote(nota, {}, deps);
    expect(r1.text).toBe('oído por small');
    await vi.waitFor(() => expect(st.loads.filter((m) => m === TURBO_STT_MODEL)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    const r2 = await transcribeVoiceNote(nota, {}, deps);
    expect(r2.text).toBe('oído por small');
    expect(r2.notice).toBeUndefined();
    expect(st.loads.filter((m) => m === TURBO_STT_MODEL)).toHaveLength(1);
    now += 11 * 60_000;
    await transcribeVoiceNote(nota, {}, deps);
    await vi.waitFor(() => expect(st.loads.filter((m) => m === TURBO_STT_MODEL)).toHaveLength(2));
  });

  it('turbo descargado pero no carga (archivo roto, sin memoria): la nota va con small', async () => {
    st.failLoad.add(TURBO_STT_MODEL);
    const r = await transcribeVoiceNote(nota, {}, { ...big, isCached: () => true });
    expect(r.text).toBe('oído por small');
  });

  it('PA_STT_MODEL=small no baja nada grande', async () => {
    const r = await transcribeVoiceNote(
      nota,
      {},
      {
        env: { PA_STT_MODEL: 'small' },
        totalMem: 16 * GB,
        isCached: () => false,
      },
    );
    expect(r.text).toBe('oído por small');
    expect(r.notice).toBeUndefined();
    expect(st.loads).toEqual([SMALL_STT_MODEL]);
  });
});
