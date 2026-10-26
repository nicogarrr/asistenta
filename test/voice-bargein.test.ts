import { describe, expect, it } from 'vitest';
import { ConversationSession, SAMPLE_RATE } from '../src/voice/conversation.js';
import { splitUtteranceGaps } from '../src/voice/stt.js';
import { speakChunked, type TtsAudio } from '../src/voice/tts.js';

const CHUNK = SAMPLE_RATE / 10;
const voice = (amp: number): Float32Array => {
  const out = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) out[i] = Math.sin((i * 2 * Math.PI * 220) / SAMPLE_RATE) * amp;
  return out;
};
const quiet = (): Float32Array => new Float32Array(CHUNK);
const feedN = (session: ConversationSession, make: () => Float32Array, n: number): void => {
  for (let i = 0; i < n; i++) session.feed(make());
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await tick();
};

function fakeAudio(text: string): TtsAudio {
  return {
    durationSeconds: 0.05,
    data: Buffer.alloc(1),
    mimeType: 'audio/mpeg',
    format: 'mp3',
    text,
    truncated: false,
  };
}

/**
 * TTS falso con `abort()`: los primeros `blockAfter` trozos resuelven y el resto
 * queda pendiente hasta que la señal se aborta. Cada abort queda registrado por
 * trozo, que es lo que permite comprobar que se cancela la síntesis EN CURSO.
 */
function fakeTts(opts: { blockAfter?: number } = {}) {
  const texts: string[] = [];
  const aborted: string[] = [];
  const blockAfter = opts.blockAfter ?? 1;
  return {
    texts,
    aborted,
    async speak(text: string, speakOpts: { signal?: AbortSignal } = {}): Promise<TtsAudio> {
      texts.push(text);
      if (texts.length <= blockAfter) return fakeAudio(text);
      const signal = speakOpts.signal;
      if (!signal) return fakeAudio(text);
      return new Promise<TtsAudio>((_resolve, reject) => {
        const onAbort = (): void => {
          aborted.push(text);
          signal.removeEventListener('abort', onAbort);
          reject(new Error('síntesis abortada'));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

describe('barge-in por defecto', () => {
  it('interrumpe al usuario, aborta la síntesis en curso y no encola los trozos pendientes', async () => {
    const turns: string[] = [];
    const session = new ConversationSession({
      tailMs: 0,
      transcriber: async () => 'eh', // ruido descartado: solo se mide el corte
      onUtterance: async (text) => {
        turns.push(text);
      },
      onClose: () => {},
    });
    const fake = fakeTts();
    const progress: string[] = [];
    let synthResult: { spoken: number; aborted: boolean } | null = null;
    let stopped = 0;

    const outcome = session.speak(
      async (ctl) => {
        synthResult = await speakChunked('Uno. Dos. Tres.', {
          tts: fake,
          signal: ctl.signal,
          onChunk: (i, total) => progress.push(`${i}/${total}`),
        });
      },
      {
        stop: () => {
          stopped++;
        },
        text: 'Uno. Dos. Tres.',
      },
    );
    await tick();
    // Primer trozo dicho; el segundo está en síntesis, el tercero ni se ha pedido.
    expect(synthResult).toBeNull();
    expect(fake.texts).toEqual(['Uno.', 'Dos.']);
    expect(progress).toEqual(['1/3']);

    // Eco de los altavoces durante la calibración y luego la voz del usuario.
    feedN(session, () => voice(0.1), 8);
    expect(stopped).toBe(0);
    feedN(session, () => voice(0.6), 5);
    expect(stopped).toBe(1);

    expect(await outcome).toBe('interrumpido');
    expect(synthResult).toEqual({ spoken: 1, aborted: true });
    expect(fake.aborted).toEqual(['Dos.']);
    expect(fake.texts).toEqual(['Uno.', 'Dos.']);
    expect(progress).toEqual(['1/3']);
    expect(session.state()).toBe('escuchando');
    expect(session.stats().bargeIns).toBe(1);
    expect(turns).toEqual([]);
  });

  it('tras el corte la sesión sigue viva: la frase nueva abre turno y su respuesta suena', async () => {
    const spoken: string[] = [];
    const turns: string[] = [];
    let session!: ConversationSession;
    session = new ConversationSession({
      tailMs: 0,
      transcriber: async () => 'nueva petición',
      onUtterance: async (text) => {
        turns.push(text);
        await session.speak(async () => {
          spoken.push('respuesta nueva');
        });
      },
      onClose: () => {},
    });
    const interrupted = session.speak(
      async (ctl) => {
        await new Promise<void>((resolve) => {
          ctl.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
      { stop: () => {} },
    );
    feedN(session, () => voice(0.1), 8);
    feedN(session, () => voice(0.6), 5);
    expect(await interrupted).toBe('interrumpido');

    // La frase que interrumpió abre un turno nuevo y su respuesta suena.
    feedN(session, quiet, 10);
    await settle();
    expect(turns).toEqual(['nueva petición']);
    expect(spoken).toEqual(['respuesta nueva']);
    expect(session.state()).toBe('escuchando');
  });

  it('bargeIn:false lo apaga del todo', async () => {
    const session = new ConversationSession({
      bargeIn: false,
      tailMs: 0,
      transcriber: async () => 'eh',
      onUtterance: async () => {},
      onClose: () => {},
    });
    let release: () => void = () => {};
    let stopped = 0;
    const outcome = session.speak(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      {
        stop: () => {
          stopped++;
        },
      },
    );
    feedN(session, () => voice(0.6), 30);
    expect(stopped).toBe(0);
    release();
    expect(await outcome).toBe('fin');
    expect(session.stats().bargeIns).toBe(0);
    expect(session.state()).toBe('escuchando');
  });
});

describe('speakChunked', () => {
  it('parte por frases, avisa de cada trozo y los sintetiza en orden', async () => {
    const fake = fakeTts({ blockAfter: 99 });
    const progress: string[] = [];
    const result = await speakChunked('Hola. Esto es una prueba. Adiós.', {
      tts: fake,
      onChunk: (i, total) => progress.push(`${i}/${total}`),
    });
    expect(fake.texts).toEqual(['Hola.', 'Esto es una prueba.', 'Adiós.']);
    expect(progress).toEqual(['1/3', '2/3', '3/3']);
    expect(result).toEqual({ spoken: 3, aborted: false });
  });

  it('no supera los 240 caracteres por trozo ni pierde texto', async () => {
    const long = `${'palabra '.repeat(80)}fin.`;
    const fake = fakeTts({ blockAfter: 99 });
    const result = await speakChunked(long, { tts: fake });
    expect(result.aborted).toBe(false);
    for (const text of fake.texts) expect(text.length).toBeLessThanOrEqual(240);
    expect(fake.texts.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' ').trim());
  });

  it('respeta chunkChars en los trozos', async () => {
    const fake = fakeTts({ blockAfter: 99 });
    await speakChunked('Uno dos tres cuatro cinco seis.', {
      tts: fake,
      chunkChars: 12,
    });
    expect(fake.texts.length).toBeGreaterThan(1);
    for (const text of fake.texts) expect(text.length).toBeLessThanOrEqual(12);
  });

  it('aborta la síntesis en curso y conserva lo ya dicho', async () => {
    const fake = fakeTts();
    const controller = new AbortController();
    const progress: string[] = [];
    const pending = speakChunked('Uno. Dos. Tres.', {
      tts: fake,
      signal: controller.signal,
      onChunk: (i, total) => progress.push(`${i}/${total}`),
    });
    await tick();
    expect(fake.texts).toEqual(['Uno.', 'Dos.']);

    controller.abort();
    expect(await pending).toEqual({ spoken: 1, aborted: true });
    expect(fake.aborted).toEqual(['Dos.']);
    expect(fake.texts).toEqual(['Uno.', 'Dos.']);
    expect(progress).toEqual(['1/3']);
  });

  it('con la señal ya cancelada no sintetiza nada, y el texto vacío no habla', async () => {
    const fake = fakeTts({ blockAfter: 99 });
    expect(await speakChunked('   ', { tts: fake })).toEqual({ spoken: 0, aborted: false });
    const controller = new AbortController();
    controller.abort();
    expect(await speakChunked('Uno.', { tts: fake, signal: controller.signal })).toEqual({
      spoken: 0,
      aborted: true,
    });
    expect(fake.texts).toEqual([]);
  });
});

type Part = { kind: 'voz' | 'fondo' | 'silencio'; ms: number };

/** PCM sintético mono int16 LE: voz, fondo continuo y silencios, por tramos. */
function syntheticPcm(parts: Part[], sampleRate = SAMPLE_RATE): Buffer {
  const total = parts.reduce((n, part) => n + Math.round((sampleRate * part.ms) / 1000), 0);
  const pcm = Buffer.alloc(total * 2);
  let at = 0;
  for (const part of parts) {
    const count = Math.round((sampleRate * part.ms) / 1000);
    for (let i = 0; i < count; i++) {
      let sample = 0;
      if (part.kind === 'voz') sample += 0.3 * Math.sin((i * 2 * Math.PI * 220) / sampleRate);
      if (part.kind !== 'silencio') {
        sample += 0.002 * Math.sin((i * 2 * Math.PI * 97) / sampleRate);
      }
      const clamped = Math.max(-1, Math.min(1, sample));
      pcm.writeInt16LE(Math.round(clamped * 32_767), at * 2);
      at++;
    }
  }
  return pcm;
}

describe('splitUtteranceGaps', () => {
  it('separa por silencios largos y conserva las pausas cortas dentro de la frase', () => {
    // 200 ms silencio + 400 voz + 200 pausa + 400 voz + 600 silencio + 300 voz + 500 silencio.
    const pcm = syntheticPcm([
      { kind: 'silencio', ms: 200 },
      { kind: 'voz', ms: 400 },
      { kind: 'silencio', ms: 200 },
      { kind: 'voz', ms: 400 },
      { kind: 'silencio', ms: 600 },
      { kind: 'voz', ms: 300 },
      { kind: 'silencio', ms: 500 },
    ]);
    expect(splitUtteranceGaps(pcm)).toEqual([
      { start: 3_200, end: 19_200 },
      { start: 28_800, end: 33_600 },
    ]);
  });

  it('minSilenceMs más corto también corta las pausas de 200 ms', () => {
    const pcm = syntheticPcm([
      { kind: 'silencio', ms: 200 },
      { kind: 'voz', ms: 400 },
      { kind: 'silencio', ms: 200 },
      { kind: 'voz', ms: 400 },
      { kind: 'silencio', ms: 600 },
      { kind: 'voz', ms: 300 },
      { kind: 'silencio', ms: 500 },
    ]);
    expect(splitUtteranceGaps(pcm, { minSilenceMs: 100 })).toEqual([
      { start: 3_200, end: 9_600 },
      { start: 12_800, end: 19_200 },
      { start: 28_800, end: 33_600 },
    ]);
  });

  it('respeta sampleRate y no inventa tramos con solo fondo o silencio', () => {
    const parts: Part[] = [
      { kind: 'fondo', ms: 500 },
      { kind: 'voz', ms: 300 },
      { kind: 'silencio', ms: 500 },
    ];
    const pcm8k = syntheticPcm(parts, 8_000);
    expect(splitUtteranceGaps(pcm8k, { sampleRate: 8_000 })).toEqual([
      { start: 4_000, end: 6_400 },
    ]);
    expect(
      splitUtteranceGaps(
        syntheticPcm([
          { kind: 'fondo', ms: 400 },
          { kind: 'silencio', ms: 400 },
        ]),
      ),
    ).toEqual([]);
  });

  it('un buffer vacío o con un byte suelto no produce tramos', () => {
    expect(splitUtteranceGaps(Buffer.alloc(0))).toEqual([]);
    expect(splitUtteranceGaps(Buffer.from([1]))).toEqual([]);
    expect(splitUtteranceGaps(Buffer.alloc(10))).toEqual([]);
  });
});
