import { describe, expect, it } from 'vitest';
import {
  type CloseReason,
  ConversationSession,
  isClosingPhrase,
  isNoise,
  SAMPLE_RATE,
} from '../src/voice/conversation.js';
import { type WakeCapture, WakeWordListener } from '../src/voice/wake.js';

/** 100 ms chunks: the audio clock is the number of samples fed, so no wall clock is involved. */
const CHUNK = SAMPLE_RATE / 10;
const voice = (): Float32Array => {
  const out = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) out[i] = Math.sin((i * 2 * Math.PI * 220) / SAMPLE_RATE) * 0.2;
  return out;
};
const quiet = (): Float32Array => new Float32Array(CHUNK);
const feedN = (s: ConversationSession, make: () => Float32Array, n: number): void => {
  for (let i = 0; i < n; i++) s.feed(make());
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await tick();
};

function build(
  over: {
    transcribe?: (s: Float32Array) => Promise<string>;
    turn?: (t: string) => Promise<void>;
    idleMs?: number;
    tailMs?: number;
    transcribeTimeoutMs?: number;
  } = {},
) {
  const heard: string[] = [];
  const lengths: number[] = [];
  const closed: Array<{ reason: CloseReason; detail?: string }> = [];
  const session = new ConversationSession({
    idleMs: over.idleMs,
    tailMs: over.tailMs ?? 0,
    transcribeTimeoutMs: over.transcribeTimeoutMs,
    transcriber: async (samples) => {
      lengths.push(samples.length);
      return over.transcribe ? over.transcribe(samples) : 'qué hora es';
    },
    onUtterance: async (t) => {
      heard.push(t);
      await over.turn?.(t);
    },
    onClose: (reason, detail) => closed.push({ reason, detail }),
  });
  return { session, heard, lengths, closed };
}

describe('frases y ruido', () => {
  it('solo cierra con frases de cierre exactas', () => {
    for (const t of [
      'Adiós',
      'Nada más.',
      'vale, para',
      'Gracias, nada más',
      'Cierra la conversación',
    ]) {
      expect(isClosingPhrase(t), t).toBe(true);
    }
    for (const t of [
      'para el timer de la cocina',
      'adiós a mi dinero en bolsa',
      'nada más llegar avísame',
    ]) {
      expect(isClosingPhrase(t), t).toBe(false);
    }
  });
  it('descarta vacío, relleno y alucinaciones conocidas de whisper', () => {
    for (const t of ['', ' ', 'eh', 'Mmm', 'Subtítulos por la comunidad de Amara.org', 'a']) {
      expect(isNoise(t), t).toBe(true);
    }
    expect(isNoise('qué tiempo hace')).toBe(false);
  });
});

describe('ConversationSession: segmentación', () => {
  it('una frase con pausa corta es UNA sola frase y lleva pre-roll', async () => {
    const { session, heard, lengths } = build();
    feedN(session, quiet, 5);
    feedN(session, voice, 6);
    feedN(session, quiet, 5); // 500 ms: dentro de la pausa, no corta
    feedN(session, voice, 4);
    feedN(session, quiet, 9); // 900 ms: corta
    await settle();
    expect(heard).toEqual(['qué hora es']);
    // pre-roll de 300 ms + 6 + 5 + 4 voz/pausa + 9 de silencio final
    expect(lengths).toHaveLength(1);
    expect(lengths[0]).toBe(CHUNK * (3 + 6 + 5 + 4 + 9));
  });

  it('un chasquido (menos de 300 ms de voz) ni se transcribe', async () => {
    const { session, heard, lengths } = build();
    feedN(session, voice, 2);
    feedN(session, quiet, 10);
    await settle();
    expect(lengths).toHaveLength(0);
    expect(heard).toEqual([]);
    expect(session.state()).toBe('escuchando');
  });

  it('el tope de 30 s corta una frase que no termina', async () => {
    const { session, lengths } = build();
    feedN(session, voice, 301);
    await settle();
    expect(lengths).toHaveLength(1);
    expect(lengths[0]).toBeLessThanOrEqual(SAMPLE_RATE * 30.2);
  });

  it('descarta ruido transcrito y sigue escuchando sin lanzar turno', async () => {
    const { session, heard } = build({
      transcribe: async () => 'Subtítulos por la comunidad de Amara.org',
    });
    feedN(session, voice, 5);
    feedN(session, quiet, 10);
    await settle();
    expect(heard).toEqual([]);
    expect(session.state()).toBe('escuchando');
  });
});

describe('ConversationSession: ciclo y cierre', () => {
  it('no recoge audio mientras responde y vuelve a escuchar al terminar', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { session, heard, lengths } = build({ turn: () => gate });
    feedN(session, voice, 5);
    feedN(session, quiet, 10);
    await settle();
    expect(session.state()).toBe('respondiendo');
    // La propia voz de la respuesta llega al micro: se tira entera.
    feedN(session, voice, 20);
    feedN(session, quiet, 20);
    release();
    await settle();
    expect(session.state()).toBe('escuchando');
    expect(lengths).toHaveLength(1);
    // Segunda frase ya normal.
    feedN(session, voice, 5);
    feedN(session, quiet, 10);
    await settle();
    expect(heard).toHaveLength(2);
  });

  it('descarta la cola de eco tras responder (tailMs)', async () => {
    const { session, lengths } = build({ tailMs: 800 });
    feedN(session, voice, 5);
    feedN(session, quiet, 10);
    await settle();
    feedN(session, voice, 8); // 800 ms de eco: ignorado
    feedN(session, quiet, 10);
    await settle();
    expect(lengths).toHaveLength(1);
  });

  it('cierra por inactividad con el reloj de audio (45 s por defecto)', async () => {
    const { session, closed } = build();
    feedN(session, quiet, 449);
    expect(closed).toEqual([]);
    feedN(session, quiet, 2);
    expect(closed).toEqual([{ reason: 'inactividad', detail: undefined }]);
    expect(session.state()).toBe('cerrada');
  });

  it('hablar reinicia la inactividad', async () => {
    const { session, closed } = build();
    feedN(session, quiet, 400);
    feedN(session, voice, 5);
    feedN(session, quiet, 10);
    await settle();
    feedN(session, quiet, 400);
    expect(closed).toEqual([]);
  });

  it('una frase de cierre cierra SIN lanzar un turno', async () => {
    const { session, heard, closed } = build({ transcribe: async () => 'Adiós.' });
    feedN(session, voice, 5);
    feedN(session, quiet, 10);
    await settle();
    expect(heard).toEqual([]);
    expect(closed.map((c) => c.reason)).toEqual(['cierre']);
  });

  it('close() durante la transcripción: el resultado se tira y no hay turno', async () => {
    let finish: (t: string) => void = () => {};
    const { session, heard, closed } = build({
      transcribe: () =>
        new Promise<string>((r) => {
          finish = r;
        }),
    });
    feedN(session, voice, 5);
    feedN(session, quiet, 10);
    await settle();
    expect(session.state()).toBe('transcribiendo');
    session.close('apagado');
    finish('hazme algo');
    await settle();
    expect(heard).toEqual([]);
    expect(closed.map((c) => c.reason)).toEqual(['apagado']);
  });

  it('close() durante el turno: no vuelve a escuchar y es idempotente', async () => {
    let release: () => void = () => {};
    const { session, closed } = build({
      turn: () =>
        new Promise<void>((r) => {
          release = r;
        }),
    });
    feedN(session, voice, 5);
    feedN(session, quiet, 10);
    await settle();
    session.close('apagado');
    session.close('apagado');
    release();
    await settle();
    expect(session.state()).toBe('cerrada');
    expect(closed).toHaveLength(1);
  });

  it('tres fallos seguidos de transcripción cierran con el motivo; uno solo no', async () => {
    let n = 0;
    const { session, closed } = build({
      transcribe: async () => {
        n++;
        throw new Error('modelo roto');
      },
    });
    for (let i = 0; i < 2; i++) {
      feedN(session, voice, 5);
      feedN(session, quiet, 10);
      await settle();
    }
    expect(closed).toEqual([]);
    feedN(session, voice, 5);
    feedN(session, quiet, 10);
    await settle();
    expect(n).toBe(3);
    expect(closed).toEqual([{ reason: 'fallo', detail: 'no consigo transcribir: modelo roto' }]);
  });

  it('una transcripción colgada se corta por timeout y cuenta como fallo', async () => {
    const { session } = build({
      transcribeTimeoutMs: 20,
      transcribe: () => new Promise<string>(() => {}),
    });
    feedN(session, voice, 5);
    feedN(session, quiet, 10);
    await new Promise((r) => setTimeout(r, 60));
    expect(session.state()).toBe('escuchando');
    expect(session.stats().lastError).toContain('tardó más de');
  });

  it('un turno que falla no cierra la sesión', async () => {
    const { session } = build({
      turn: async () => {
        throw new Error('el modelo no respondió');
      },
    });
    feedN(session, voice, 5);
    feedN(session, quiet, 10);
    await settle();
    expect(session.state()).toBe('escuchando');
    expect(session.stats().lastError).toBe('el modelo no respondió');
  });

  it('submit() lanza la petición que venía con la palabra; solo escuchando', async () => {
    const { session, heard } = build();
    await session.submit('apaga la luz');
    expect(heard).toEqual(['apaga la luz']);
    session.close('apagado');
    await session.submit('otra cosa');
    expect(heard).toEqual(['apaga la luz']);
  });

  it('el audio después de cerrar se ignora', async () => {
    const { session, lengths } = build();
    session.close('apagado');
    feedN(session, voice, 5);
    feedN(session, quiet, 10);
    await settle();
    expect(lengths).toHaveLength(0);
  });
});

describe('ConversationSession: saludo, ruido continuo y solapes', () => {
  it('el saludo no se oye a sí mismo: el eco durante speak() y su cola no llegan al turno', async () => {
    const { session, heard, lengths } = build({ tailMs: 800 });
    let release: () => void = () => {};
    const playing = session.speak(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    expect(session.state()).toBe('hablando');
    feedN(session, voice, 10); // el "Dime." saliendo por el altavoz
    feedN(session, quiet, 10);
    release();
    await playing;
    expect(session.state()).toBe('escuchando');
    feedN(session, voice, 8); // cola de eco tras terminar
    feedN(session, quiet, 10);
    await settle();
    expect(lengths).toHaveLength(0);
    expect(heard).toEqual([]);
    // y después escucha de verdad
    feedN(session, voice, 5);
    feedN(session, quiet, 10);
    await settle();
    expect(heard).toEqual(['qué hora es']);
  });

  it('speak() que falla no cierra la sesión y deja el fallo visible', async () => {
    const { session } = build();
    await session.speak(async () => {
      throw new Error('sin altavoz');
    });
    expect(session.state()).toBe('escuchando');
    expect(session.stats().lastError).toBe('sin altavoz');
  });

  it('ruido continuo transcrito como alucinación NO mantiene la sesión abierta', async () => {
    let calls = 0;
    const { session, closed, heard } = build({
      transcribe: async () => {
        calls++;
        return 'Gracias por ver el video';
      },
    });
    // 180 s de ruido continuo: tramos de 30 s.
    for (let i = 0; i < 6 && session.state() !== 'cerrada'; i++) {
      feedN(session, voice, 301);
      await settle();
    }
    expect(closed.map((c) => c.reason)).toEqual(['inactividad']);
    expect(calls).toBeLessThan(6);
    expect(heard).toEqual([]);
  });

  it('un turno real sí reinicia el reloj de inactividad tras ruido descartado', async () => {
    let n = 0;
    const { session, closed } = build({
      transcribe: async () => (++n === 1 ? 'eh' : 'qué hora es'),
    });
    feedN(session, quiet, 300);
    feedN(session, voice, 5);
    feedN(session, quiet, 10); // ruido descartado: no reinicia
    await settle();
    feedN(session, voice, 5);
    feedN(session, quiet, 10); // turno real: reinicia
    await settle();
    feedN(session, quiet, 440);
    expect(closed).toEqual([]);
  });

  it('una transcripción que sobrevive a su timeout no se solapa con otra', async () => {
    let calls = 0;
    let finish: (t: string) => void = () => {};
    const { session, heard } = build({
      transcribeTimeoutMs: 20,
      transcribe: () => {
        calls++;
        if (calls === 1) {
          return new Promise<string>((r) => {
            finish = r;
          });
        }
        return Promise.resolve('qué hora es');
      },
    });
    feedN(session, voice, 5);
    feedN(session, quiet, 10);
    await new Promise((r) => setTimeout(r, 60));
    expect(session.state()).toBe('escuchando');
    feedN(session, voice, 5);
    feedN(session, quiet, 10); // la primera sigue viva: esta se descarta
    await settle();
    expect(calls).toBe(1);
    finish('tarde');
    await settle();
    feedN(session, voice, 5);
    feedN(session, quiet, 10);
    await settle();
    expect(calls).toBe(2);
    expect(heard).toEqual(['qué hora es']);
  });
});

describe('WakeWordListener: tap de audio y hold', () => {
  function fakeCapture() {
    let push: (p: Float32Array) => void = () => {};
    const capture: WakeCapture = {
      async start(onChunk) {
        push = onChunk;
      },
      async stop() {},
    };
    return { capture, emit: (p: Float32Array) => push(p) };
  }

  it('el tap recibe el audio con hold activo y la palabra no se transcribe', async () => {
    const { capture, emit } = fakeCapture();
    const tapped: number[] = [];
    let transcribed = 0;
    const listener = new WakeWordListener({
      capture,
      checkIntervalMs: 100,
      onAudio: (p) => tapped.push(p.length),
      transcriber: async () => {
        transcribed++;
        return 'asistenta';
      },
    });
    await listener.start();
    listener.hold(true);
    emit(voice());
    emit(voice());
    await new Promise((r) => setTimeout(r, 350));
    expect(tapped).toEqual([CHUNK, CHUNK]);
    expect(transcribed).toBe(0);
    listener.hold(false);
    emit(voice());
    await new Promise((r) => setTimeout(r, 350));
    expect(transcribed).toBeGreaterThan(0);
    await listener.stop();
  });

  it('un tap que lanza no tumba el oyente', async () => {
    const { capture, emit } = fakeCapture();
    const errors: string[] = [];
    const listener = new WakeWordListener({
      capture,
      onAudio: () => {
        throw new Error('tap roto');
      },
      onError: (e) => errors.push(e.message),
      transcriber: async () => '',
    });
    await listener.start();
    emit(voice());
    expect(errors).toEqual(['tap roto']);
    expect(listener.isRunning()).toBe(true);
    await listener.stop();
  });

  it('tras stop() el tap ya no recibe audio', async () => {
    const { capture, emit } = fakeCapture();
    const tapped: number[] = [];
    const listener = new WakeWordListener({
      capture,
      onAudio: (p) => tapped.push(p.length),
      transcriber: async () => '',
    });
    await listener.start();
    await listener.stop();
    emit(voice());
    expect(tapped).toEqual([]);
  });
});
