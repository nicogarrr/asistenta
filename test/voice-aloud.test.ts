import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAloudSpeaker } from '../src/voice/aloud.js';
import { ConversationSession, SAMPLE_RATE, type SpeakControl } from '../src/voice/conversation.js';
import type { Playback, Speaker } from '../src/voice/speaker.js';
import type { Tts, TtsAudio } from '../src/voice/tts.js';

const CHUNK = SAMPLE_RATE / 10;
const voice = (amp: number): Float32Array => {
  const out = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) out[i] = Math.sin((i * 2 * Math.PI * 220) / SAMPLE_RATE) * amp;
  return out;
};
const feedN = (session: ConversationSession, make: () => Float32Array, n: number): void => {
  for (let i = 0; i < n; i++) session.feed(make());
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await tick();
};

function fakeAudio(text: string): TtsAudio {
  return {
    durationSeconds: 0.05,
    data: Buffer.from(`mp3:${text}`),
    mimeType: 'audio/mpeg',
    format: 'mp3',
    text,
    truncated: false,
  };
}

/**
 * TTS falso: los primeros `blockAfter` trozos resuelven y el resto queda
 * pendiente hasta que la señal se aborta. Registra los aborts por trozo, que
 * es lo que permite comprobar que la señal del SpeakControl llega a SAPI.
 */
function fakeTts(opts: { blockAfter?: number } = {}) {
  const texts: string[] = [];
  const aborted: string[] = [];
  const blockAfter = opts.blockAfter ?? 1;
  const tts: Tts = {
    name: 'fake',
    async speak(text: string, speakOpts: { signal?: AbortSignal } = {}): Promise<TtsAudio> {
      texts.push(text);
      if (texts.length <= blockAfter) return fakeAudio(text);
      const signal = speakOpts.signal;
      if (!signal) return fakeAudio(text);
      return new Promise<TtsAudio>((_resolve, reject) => {
        const onAbort = (): void => {
          aborted.push(text);
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
  return { tts, texts, aborted };
}

/** Speaker falso: la frase en curso suena hasta que la paran o la terminan. */
function fakeSpeaker() {
  const played: string[] = [];
  const stopped: string[] = [];
  let finishCurrent: (() => void) | null = null;
  const speaker: Speaker = {
    play(file: string): Playback {
      played.push(file);
      let doneResolve!: () => void;
      const done = new Promise<void>((res) => {
        doneResolve = res;
      });
      finishCurrent = () => doneResolve();
      return {
        done,
        stop: () => {
          stopped.push(file);
          doneResolve();
        },
      };
    },
  };
  return { speaker, played, stopped, finishCurrent: () => finishCurrent?.() };
}

function fakeCtl(signal: AbortSignal): SpeakControl & { starts: number } {
  const ctl = {
    starts: 0,
    phraseStart: () => {
      ctl.starts++;
    },
    interrupted: () => signal.aborted,
    signal,
  };
  return ctl;
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'aloud-test-'));
}

describe('createAloudSpeaker', () => {
  it('lee todas las frases en orden, avisa al ctl y suelta el playback al terminar', async () => {
    const dir = tmp();
    try {
      const { tts, texts } = fakeTts({ blockAfter: 99 });
      const sp = fakeSpeaker();
      // Auto-termina cada frase en el siguiente tick, como un reproductor que acaba.
      const base = sp.speaker.play;
      sp.speaker.play = (file: string): Playback => {
        const p = base(file);
        setTimeout(() => sp.finishCurrent(), 0);
        return p;
      };
      const seen: Array<Playback | null> = [];
      const aloud = createAloudSpeaker(['Uno.', 'Dos.', 'Tres.'], {
        tts,
        speaker: sp.speaker,
        directory: dir,
        isOwnerCurrent: () => true,
        setPlayback: (p) => seen.push(p),
      });
      const ctl = fakeCtl(new AbortController().signal);
      await aloud.run(ctl);
      expect(texts).toEqual(['Uno.', 'Dos.', 'Tres.']);
      expect(sp.played).toHaveLength(3);
      expect(ctl.starts).toBe(3);
      expect(seen[seen.length - 1]).toBeNull();
      // Ningún mp3 de trabajo queda en el directorio.
      expect(readdirSync(dir).filter((f) => f.startsWith('say-'))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sin frases o con el dueño fuera no sintetiza nada', async () => {
    const dir = tmp();
    try {
      const { tts, texts } = fakeTts();
      const aloud = createAloudSpeaker([], {
        tts,
        speaker: fakeSpeaker().speaker,
        directory: dir,
        isOwnerCurrent: () => true,
        setPlayback: () => {},
      });
      await aloud.run(fakeCtl(new AbortController().signal));
      const gone = createAloudSpeaker(['Uno.'], {
        tts,
        speaker: fakeSpeaker().speaker,
        directory: dir,
        isOwnerCurrent: () => false,
        setPlayback: () => {},
      });
      await gone.run(fakeCtl(new AbortController().signal));
      expect(texts).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('un fallo de síntesis sin corte se propaga (no se traga)', async () => {
    const dir = tmp();
    try {
      const failing: Tts = {
        name: 'fake',
        speak: async () => {
          throw new Error('SAPI roto');
        },
      };
      const aloud = createAloudSpeaker(['Uno.'], {
        tts: failing,
        speaker: fakeSpeaker().speaker,
        directory: dir,
        isOwnerCurrent: () => true,
        setPlayback: () => {},
      });
      await expect(aloud.run(fakeCtl(new AbortController().signal))).rejects.toThrow('SAPI roto');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createAloudSpeaker + sesión (duplex)', () => {
  it('un barge-in aborta la síntesis EN CURSO de la frase siguiente, no solo el altavoz', async () => {
    const dir = tmp();
    try {
      const session = new ConversationSession({
        tailMs: 0,
        transcriber: async () => 'eh', // ruido descartado: solo se mide el corte
        onUtterance: async () => {},
        onClose: () => {},
      });
      const { tts, texts, aborted } = fakeTts({ blockAfter: 1 });
      const sp = fakeSpeaker();
      const playbacks: Array<Playback | null> = [];
      const aloud = createAloudSpeaker(['Uno.', 'Dos.', 'Tres.'], {
        tts,
        speaker: sp.speaker,
        directory: dir,
        isOwnerCurrent: () => true,
        setPlayback: (p) => playbacks.push(p),
      });

      const outcome = session.speak((ctl) => aloud.run(ctl), {
        stop: () => aloud.abort(),
        text: 'Uno. Dos. Tres.',
      });
      await settle();
      // 'Uno.' suena; 'Dos.' está en síntesis; 'Tres.' ni se ha pedido.
      expect(sp.played).toHaveLength(1);
      expect(texts).toEqual(['Uno.', 'Dos.']);
      expect(playbacks[0]).not.toBeNull();

      // Eco de los altavoces durante la calibración y luego la voz del usuario.
      feedN(session, () => voice(0.1), 8);
      expect(sp.stopped).toHaveLength(0);
      feedN(session, () => voice(0.6), 5);

      expect(await outcome).toBe('interrumpido');
      // El altavoz se calló y la síntesis de 'Dos.' se ABORTÓ en vuelo.
      expect(sp.stopped).toHaveLength(1);
      expect(aborted).toEqual(['Dos.']);
      expect(texts).toEqual(['Uno.', 'Dos.']);
      expect(session.state()).toBe('escuchando');
      expect(session.stats().bargeIns).toBe(1);
      await settle();
      expect(readdirSync(dir).filter((f) => f.startsWith('say-'))).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
