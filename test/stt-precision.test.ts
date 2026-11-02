import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sin modelo ni red: whisper falso que deja ver qué se le pide (modelo, audio, pista).
const st = vi.hoisted(() => ({
  seconds: 2,
  models: [] as string[],
  generateCalls: [] as Array<{
    inputs: unknown;
    decoder_input_ids: number[];
    max_new_tokens: number;
  }>,
  processed: [] as Float32Array[],
  pipeCalls: [] as Array<{ samples: Float32Array; opts: Record<string, unknown> }>,
  /** Lo que «oye» el decodificador con pista (tokens de texto ya sin el prefijo). */
  heard: 'pon en YouTube Bailando de Enrique Iglesias',
  plain: 'ponen dios tuve bailando de enrique y lesias',
  /** Logit del token elegido frente a otro a 0: 8 ≈ seguro (log-prob ≈ 0), 0 = duda (−0,69). */
  confPrompt: 8,
  confPlain: 8,
}));

// Tokenizador de juguete: una palabra = un token; los especiales con id fijo.
const SPECIAL: Record<string, number> = {
  '<|startofprev|>': 50361,
  '<|startoftranscript|>': 50258,
  '<|es|>': 50262,
  '<|transcribe|>': 50359,
  '<|notimestamps|>': 50363,
};
const vocab: string[] = [];
const idOf = (w: string) => {
  let i = vocab.indexOf(w);
  if (i < 0) i = vocab.push(w) - 1;
  return 1000 + i;
};

vi.mock('../src/voice/decode.js', () => ({
  decodeForWhisper: async () => ({
    // Voz desde la primera muestra, como una nota grabada nada más pulsar.
    samples: Float32Array.from(
      { length: Math.round(16_000 * st.seconds) },
      (_, i) => 0.3 * Math.sin(i / 5),
    ),
    sampleRate: 16_000,
  }),
}));

vi.mock('@huggingface/transformers', () => ({
  LogLevel: { ERROR: 40 },
  env: {},
  pipeline: async (_task: string, model: string) => {
    st.models.push(model);
    const pipe = async (samples: Float32Array, opts: Record<string, unknown>) => {
      st.pipeCalls.push({ samples, opts });
      return { text: ` ${st.plain}` };
    };
    return Object.assign(pipe, {
      processor: async (samples: Float32Array) => {
        st.processed.push(samples);
        return { input_features: { dims: [1, 80, 3000] } };
      },
      tokenizer: {
        convert_tokens_to_ids: (t: string) => SPECIAL[t] ?? -1,
        encode: (text: string) => text.trim().split(/\s+/).map(idOf),
        decode: (ids: number[]) =>
          ids
            .filter((i) => i >= 1000)
            .map((i) => vocab[i - 1000])
            .join(' '),
      },
      model: {
        generate: async (args: {
          inputs: unknown;
          decoder_input_ids: number[];
          max_new_tokens: number;
          logits_processor?: Array<(ids: unknown, logits: { data: Float32Array }) => unknown>;
        }) => {
          st.generateCalls.push(args);
          const prompted = args.decoder_input_ids[0] === SPECIAL['<|startofprev|>'];
          const words = (prompted ? st.heard : st.plain).split(/\s+/);
          const conf = prompted ? st.confPrompt : st.confPlain;
          for (const _w of words) {
            for (const p of args.logits_processor ?? [])
              p([], { data: Float32Array.from([conf, 0]) });
          }
          const out = words.map(idOf);
          return { tolist: () => [[...args.decoder_input_ids, ...out]] };
        },
      },
    });
  },
}));

import { createLocalWhisperStt, looksLikeWhisperLoop, STT_PROMPT } from '../src/voice/stt.js';

beforeEach(() => {
  st.seconds = 2;
  st.models.length = 0;
  st.generateCalls.length = 0;
  st.processed.length = 0;
  st.pipeCalls.length = 0;
  st.heard = 'pon en YouTube Bailando de Enrique Iglesias';
  st.confPrompt = 8;
  st.confPlain = 8;
});

const nota = Buffer.from('OggS falso');

describe('notas de voz: «pon en YouTube Bailando de Enrique Iglesias» se entiende', () => {
  it('usa whisper-small (el mismo que la palabra de activación), no whisper-base', async () => {
    await createLocalWhisperStt().transcribe(nota);
    expect(st.models).toContain('onnx-community/whisper-small');
    expect(st.models).not.toContain('onnx-community/whisper-base');
  });

  it('decodifica en castellano con la pista de órdenes (YouTube, Netflix, Spotify…) y la pista no sale en el texto', async () => {
    const r = await createLocalWhisperStt().transcribe(nota);
    expect(r.text).toBe('pon en YouTube Bailando de Enrique Iglesias');
    expect(STT_PROMPT).toMatch(/YouTube/);
    expect(STT_PROMPT).toMatch(/Netflix/);
    expect(STT_PROMPT).toMatch(/Spotify/);
    const ids = st.generateCalls[0]?.decoder_input_ids ?? [];
    expect(ids[0]).toBe(SPECIAL['<|startofprev|>']);
    expect(ids.slice(-4)).toEqual([
      SPECIAL['<|startoftranscript|>'],
      SPECIAL['<|es|>'],
      SPECIAL['<|transcribe|>'],
      SPECIAL['<|notimestamps|>'],
    ]);
    expect(ids).toContain(idOf('YouTube'));
    // Tope de tokens según la duración: una pista nunca convierte 2 s en un párrafo.
    expect(st.generateCalls[0]?.max_new_tokens).toBeLessThan(60);
  });

  it('añade silencio delante y detrás: la primera palabra («pon») no se pierde', async () => {
    await createLocalWhisperStt().transcribe(nota);
    const s = st.processed[0];
    expect(s).toBeDefined();
    if (!s) return;
    expect(s.length).toBeGreaterThanOrEqual(16_000 * 2 + 2 * 0.4 * 16_000);
    // Las primeras 0,4 s son silencio puro; la voz empieza después.
    expect(s.subarray(0, 6400).every((v) => v === 0)).toBe(true);
    expect(s.subarray(s.length - 6400).every((v) => v === 0)).toBe(true);
  });

  it('si con la pista sale un bucle, repite sin pista', async () => {
    st.heard = 'abre Netflix en la tele de la tele de la tele de la tele de la tele de la tele';
    const r = await createLocalWhisperStt().transcribe(nota);
    expect(st.generateCalls).toHaveLength(2);
    expect(st.generateCalls[1]?.decoder_input_ids[0]).toBe(SPECIAL['<|startoftranscript|>']);
    expect(r.text).toBe(st.plain);
  });

  it('si copia la pista en vez de oír el audio, repite sin pista', async () => {
    st.heard = 'Abre Netflix, Spotify, Disney+,';
    const r = await createLocalWhisperStt().transcribe(nota);
    expect(st.generateCalls).toHaveLength(2);
    expect(r.text).toBe(st.plain);
  });

  it('si con la pista el modelo duda («like and subscribe») y sin pista está seguro, gana la de sin pista', async () => {
    st.heard = 'like and subscribe';
    st.confPrompt = 0;
    const r = await createLocalWhisperStt().transcribe(nota);
    expect(st.generateCalls).toHaveLength(2);
    expect(r.text).toBe(st.plain);
  });

  it('si duda con las dos, se queda con la de la pista (la que conoce «YouTube»)', async () => {
    st.confPrompt = 0;
    st.confPlain = 0;
    const r = await createLocalWhisperStt().transcribe(nota);
    expect(st.generateCalls).toHaveLength(2);
    expect(r.text).toBe('pon en YouTube Bailando de Enrique Iglesias');
  });

  it('una orden bien oída con pista no paga una segunda pasada', async () => {
    await createLocalWhisperStt().transcribe(nota);
    expect(st.generateCalls).toHaveLength(1);
    expect(st.pipeCalls).toHaveLength(0);
  });

  it('un audio de más de 30 s va por trozos como antes (sin pista)', async () => {
    st.seconds = 45;
    const r = await createLocalWhisperStt().transcribe(nota);
    expect(st.generateCalls).toHaveLength(0);
    expect(st.pipeCalls[0]?.opts).toMatchObject({ language: 'spanish', chunk_length_s: 30 });
    expect(r.durationSeconds).toBe(45);
  });

  it('la palabra de activación y las notas de voz comparten un solo whisper-small en memoria', async () => {
    vi.resetModules();
    const stt = await import('../src/voice/stt.js');
    const wake = await import('../src/voice/wake.js');
    await stt.createLocalWhisperStt().transcribe(nota);
    await wake.defaultTranscriber(new Float32Array(16_000));
    await stt.createLocalWhisperStt().transcribe(nota);
    expect(st.models).toEqual(['onnx-community/whisper-small']);
  });

  it('detector de bucles: repeticiones sí, frases normales no', () => {
    expect(looksLikeWhisperLoop('la tele de la tele de la tele de la tele de la tele')).toBe(true);
    expect(looksLikeWhisperLoop('gracias gracias gracias gracias gracias')).toBe(true);
    expect(looksLikeWhisperLoop('baja el volumen de la tele del salón')).toBe(false);
    expect(looksLikeWhisperLoop('pon en YouTube Bailando de Enrique Iglesias')).toBe(false);
    expect(looksLikeWhisperLoop('sí, sí, claro')).toBe(false);
  });
});
