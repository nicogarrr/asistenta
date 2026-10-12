import { describe, expect, it } from 'vitest';
import { ConversationSession, SAMPLE_RATE } from '../src/voice/conversation.js';
import { speakPhrases, splitPhrases } from '../src/voice/phrases.js';
import type { Playback } from '../src/voice/speaker.js';

const CHUNK = SAMPLE_RATE / 10;
const tone = (amp: number): Float32Array => {
  const out = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) out[i] = Math.sin((i * 2 * Math.PI * 220) / SAMPLE_RATE) * amp;
  return out;
};
const echo = (): Float32Array => tone(0.1); // rms ~0.07: above the gate, the room hearing the speaker
const user = (): Float32Array => tone(0.5);
const quiet = (): Float32Array => new Float32Array(CHUNK);
const feedN = (s: ConversationSession, make: () => Float32Array, n: number): void => {
  for (let i = 0; i < n; i++) s.feed(make());
};
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function build(
  over: { bargeIn?: 'off' | 'normal' | 'sensible'; transcribe?: () => Promise<string> } = {},
) {
  const heard: string[] = [];
  const lengths: number[] = [];
  const closed: string[] = [];
  const session = new ConversationSession({
    tailMs: 0,
    bargeIn: over.bargeIn,
    transcriber: async (samples) => {
      lengths.push(samples.length);
      return over.transcribe ? over.transcribe() : 'para el timer';
    },
    onUtterance: async (t) => {
      heard.push(t);
    },
    onClose: (r) => closed.push(r),
  });
  return { session, heard, lengths, closed };
}

/** A speech run that lasts until released or stopped, like a playback. */
function fakeSpeech() {
  let release: () => void = () => {};
  const finished = new Promise<void>((r) => {
    release = r;
  });
  let stopped = 0;
  return {
    run: async () => {
      await finished;
    },
    stop: () => {
      stopped++;
      release();
    },
    release,
    stoppedCount: () => stopped,
  };
}

describe('barge-in', () => {
  it('el eco propio, por alto que sea, no interrumpe (se calibra en los primeros 500 ms)', async () => {
    const { session, lengths } = build();
    const speech = fakeSpeech();
    const outcome = session.speak(speech.run, { stop: speech.stop });
    feedN(session, echo, 40); // 4 s de eco constante
    expect(speech.stoppedCount()).toBe(0);
    speech.release();
    expect(await outcome).toBe('fin');
    expect(lengths).toHaveLength(0);
    expect(session.stats().bargeIns).toBe(0);
  });

  it('voz sostenida sobre el eco corta el sonido y pasa a ser la siguiente frase', async () => {
    const { session, heard, lengths } = build();
    const speech = fakeSpeech();
    const outcome = session.speak(speech.run, { stop: speech.stop });
    feedN(session, echo, 8); // calibración (500 ms) + algo más
    feedN(session, user, 3); // 300 ms: todavía no
    expect(speech.stoppedCount()).toBe(0);
    feedN(session, user, 2); // 500 ms sostenidos: corta
    expect(speech.stoppedCount()).toBe(1);
    expect(await outcome).toBe('interrumpido');
    expect(session.state()).toBe('escuchando');
    expect(session.stats().bargeIns).toBe(1);
    feedN(session, user, 4);
    feedN(session, quiet, 10);
    await settle();
    expect(lengths).toHaveLength(1);
    // lleva pre-roll (eco previo) y TODA la voz que causó el corte
    expect(lengths[0]).toBeGreaterThanOrEqual(CHUNK * (5 + 4 + 9));
    expect(heard).toEqual(['para el timer']);
  });

  it('un pico corto (menos de 400 ms) no corta', () => {
    const { session } = build();
    const speech = fakeSpeech();
    void session.speak(speech.run, { stop: speech.stop });
    feedN(session, echo, 8);
    feedN(session, user, 3);
    feedN(session, echo, 2);
    feedN(session, user, 3);
    expect(speech.stoppedCount()).toBe(0);
  });

  it('sensible corta con menos voz que normal', () => {
    const a = build({ bargeIn: 'sensible' });
    const speech = fakeSpeech();
    void a.session.speak(speech.run, { stop: speech.stop });
    feedN(a.session, echo, 6);
    feedN(a.session, user, 3); // 300 ms >= 250
    expect(speech.stoppedCount()).toBe(1);
  });

  it('con corte off no se oye nada mientras habla (comportamiento V1)', async () => {
    const { session, lengths } = build({ bargeIn: 'off' });
    const speech = fakeSpeech();
    const outcome = session.speak(speech.run, { stop: speech.stop });
    feedN(session, user, 30);
    expect(speech.stoppedCount()).toBe(0);
    speech.release();
    expect(await outcome).toBe('fin');
    expect(lengths).toHaveLength(0);
  });

  it('cada frase recalibra el eco: un eco más fuerte en la frase siguiente no corta', () => {
    const { session } = build();
    const speech = fakeSpeech();
    const ctlBox: { ctl?: { phraseStart(): void } } = {};
    void session.speak(
      async (c) => {
        ctlBox.ctl = c;
        await speech.run();
      },
      { stop: speech.stop },
    );
    feedN(session, echo, 10);
    ctlBox.ctl?.phraseStart();
    const loud = (): Float32Array => tone(0.3); // eco más fuerte (volumen del sistema subido)
    feedN(session, loud, 20);
    expect(speech.stoppedCount()).toBe(0);
  });

  it('la respuesta interrumpida no reanuda la escucha por encima de un turno nuevo', async () => {
    let n = 0;
    const turns: string[] = [];
    let session!: ConversationSession;
    const speech = fakeSpeech();
    session = new ConversationSession({
      tailMs: 0,
      transcriber: async () => `frase ${++n}`,
      onUtterance: async (t) => {
        turns.push(t);
        if (t === 'frase 1') await session.speak(speech.run, { stop: speech.stop });
      },
      onClose: () => {},
    });
    feedN(session, user, 5);
    feedN(session, quiet, 10);
    await settle();
    expect(session.state()).toBe('hablando');
    feedN(session, echo, 8);
    feedN(session, user, 5); // interrumpe
    await settle();
    feedN(session, user, 3);
    feedN(session, quiet, 10);
    await settle();
    expect(turns).toEqual(['frase 1', 'frase 2']);
    expect(session.state()).toBe('escuchando');
  });

  it('close() mientras habla no reanuda nada y no deja la sesión colgada', async () => {
    const { session, closed } = build();
    const speech = fakeSpeech();
    const outcome = session.speak(speech.run, { stop: speech.stop });
    session.close('apagado');
    speech.release();
    await outcome;
    expect(session.state()).toBe('cerrada');
    expect(closed).toEqual(['apagado']);
  });
});

describe('splitPhrases', () => {
  it('corta por frases y une las muy cortas', () => {
    expect(
      splitPhrases('Hola. Son las tres y media de la tarde. Que tengas buen día, hasta luego.'),
    ).toEqual(['Hola. Son las tres y media de la tarde.', 'Que tengas buen día, hasta luego.']);
  });
  it('no pasa de 240 caracteres por frase y no pierde texto', () => {
    const long = `${'palabra '.repeat(80)}fin.`;
    const parts = splitPhrases(long);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(240);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' ').trim());
  });
  it('vacío -> nada', () => {
    expect(splitPhrases('   ')).toEqual([]);
  });
});

describe('speakPhrases', () => {
  function rig(opts: { failSynthAt?: number } = {}) {
    const log: string[] = [];
    const files = new Set<string>();
    const releases: Array<() => void> = [];
    const runner = {
      synth: async (t: string) => {
        log.push(`synth:${t}`);
        if (opts.failSynthAt !== undefined && t === `p${opts.failSynthAt}`)
          throw new Error('tts roto');
        const f = `f-${t}`;
        files.add(f);
        return f;
      },
      play: (f: string): Playback => {
        log.push(`play:${f}`);
        let resolve: () => void = () => {};
        const done = new Promise<void>((r) => {
          resolve = r;
        });
        releases.push(resolve);
        return {
          done,
          stop: () => {
            log.push(`stop:${f}`);
            resolve();
          },
        };
      },
      remove: (f: string) => {
        files.delete(f);
        log.push(`rm:${f}`);
      },
    };
    return { log, files, releases, runner };
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('sintetiza la siguiente mientras suena la actual y las dice en orden', async () => {
    const { log, files, releases, runner } = rig();
    const h = speakPhrases(['p1', 'p2', 'p3'], runner);
    await tick();
    await tick();
    expect(log.indexOf('synth:p2')).toBeLessThan(log.indexOf('play:f-p1') + 1);
    expect(log).toContain('synth:p2'); // ya sintetizada con p1 sonando
    expect(log).not.toContain('synth:p3');
    releases[0]?.();
    await tick();
    await tick();
    releases[1]?.();
    await tick();
    await tick();
    releases[2]?.();
    expect(await h.done).toEqual({ spoken: 3, aborted: false });
    expect(log.filter((l) => l.startsWith('play:'))).toEqual([
      'play:f-p1',
      'play:f-p2',
      'play:f-p3',
    ]);
    expect(files.size).toBe(0);
  });

  it('abort corta el sonido, no reproduce lo pendiente y borra todos los ficheros', async () => {
    const { log, files, runner } = rig();
    const h = speakPhrases(['p1', 'p2', 'p3'], runner);
    await tick();
    await tick();
    h.abort();
    const res = await h.done;
    await tick();
    expect(res.aborted).toBe(true);
    expect(res.spoken).toBeLessThan(2);
    expect(log).not.toContain('play:f-p2');
    expect(log).toContain('stop:f-p1');
    expect(files.size).toBe(0);
  });

  it('un fallo de síntesis a medias rechaza tras limpiar', async () => {
    const { files, releases, runner } = rig({ failSynthAt: 2 });
    const h = speakPhrases(['p1', 'p2'], runner);
    await tick();
    releases[0]?.();
    await expect(h.done).rejects.toThrow('tts roto');
    expect(files.size).toBe(0);
  });
});
