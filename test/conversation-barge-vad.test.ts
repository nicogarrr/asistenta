import { describe, expect, it } from 'vitest';
import { ConversationSession, SAMPLE_RATE } from '../src/voice/conversation.js';

/**
 * Corte confirmado por VAD: un candidato ruidoso ya no corta el sonido hasta que
 * el detector dice que es habla. El reloj es el audio alimentado; el VAD es una
 * función inyectada, determinista.
 */
const CHUNK = SAMPLE_RATE / 10;
const voice = (amp = 0.2): Float32Array => {
  const out = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) out[i] = Math.sin((i * 2 * Math.PI * 220) / SAMPLE_RATE) * amp;
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

function build(over: {
  vad?: (samples: Float32Array) => Promise<number>;
  transcribe?: string;
  vadRecheckMs?: number;
  vadTimeoutMs?: number;
}) {
  const heard: string[] = [];
  const session = new ConversationSession({
    bargeIn: 'auriculares',
    bargeVad: over.vad,
    bargeVadRecheckMs: over.vadRecheckMs,
    bargeVadTimeoutMs: over.vadTimeoutMs,
    tailMs: 0,
    transcriber: async () => over.transcribe ?? 'qué hora es',
    onUtterance: async (t) => {
      heard.push(t);
    },
    onClose: () => {},
  });
  return { session, heard };
}

/**
 * La sesión habla hasta que la interrumpen (o 200 ticks si nadie lo hace); los
 * feeds ocurren con el run en vuelo, como en el test de barge por energía.
 */
async function speakAndFeed(
  session: ConversationSession,
  opts: { chunks?: number; amp?: number; text?: string } = {},
): Promise<{ stopped: boolean; outcome: string }> {
  let stopped = false;
  const p = session.speak(
    async (ctl) => {
      for (let i = 0; i < 200 && !ctl.interrupted(); i++) await tick();
    },
    {
      stop: () => {
        stopped = true;
      },
      text: opts.text,
    },
  );
  feedN(session, () => voice(opts.amp ?? 0.2), opts.chunks ?? 4);
  await settle();
  const outcome = await p;
  return { stopped, outcome };
}

describe('barge-in confirmado por VAD', () => {
  it('ruido sostenido que el VAD rechaza NO corta: el agente acaba de hablar', async () => {
    let calls = 0;
    const { session } = build({
      vad: async () => {
        calls++;
        return 0.05;
      },
    });
    const { stopped, outcome } = await speakAndFeed(session, { chunks: 4 });
    await settle();
    expect(stopped).toBe(false);
    expect(outcome).toBe('fin');
    expect(calls).toBe(1);
    const st = session.stats();
    expect(st.bargeIns).toBe(0);
    expect(st.bargeVadRejected).toBe(1);
    // La frase terminó sola y la sesión volvió a escuchar: nunca se cortó.
    expect(session.state()).toBe('escuchando');
  });

  it('habla confirmada por el VAD corta y siembra el turno como antes', async () => {
    const { session, heard } = build({ vad: async () => 0.9, transcribe: 'qué hora es' });
    const { stopped, outcome } = await speakAndFeed(session, { chunks: 4 });
    expect(stopped).toBe(true);
    expect(outcome).toBe('interrumpido');
    expect(session.state()).toBe('escuchando');
    feedN(session, quiet, 10);
    await settle();
    const st = session.stats();
    expect(st.bargeIns).toBe(1);
    expect(st.bargeTrue).toBe(1);
    expect(st.bargeVadRejected).toBe(0);
    expect(heard).toEqual(['qué hora es']);
  });

  it('fallo del VAD: comportamiento de energía (interrumpe), y se cuenta el fallo', async () => {
    const { session } = build({
      vad: async () => {
        throw new Error('onnx caído');
      },
    });
    const { stopped, outcome } = await speakAndFeed(session, { chunks: 4 });
    expect(stopped).toBe(true);
    expect(outcome).toBe('interrumpido');
    const st = session.stats();
    expect(st.bargeIns).toBe(1);
    expect(st.lastError).toMatch(/detector de voz falló/);
  });

  it('3 fallos seguidos del VAD lo descartan por la sesión: el 4º ni lo llama', async () => {
    let calls = 0;
    const { session } = build({
      vad: async () => {
        calls++;
        throw new Error('onnx caído');
      },
    });
    // Tres candidatos, cada uno interrumpe por fallback y la sesión vuelve a hablar.
    for (let i = 0; i < 3; i++) {
      await speakAndFeed(session, { chunks: 4 });
      feedN(session, quiet, 10);
      await settle();
    }
    expect(calls).toBe(3);
    expect(session.stats().lastError).toMatch(/3 veces seguidas/);
    // Cuarto candidato: sin VAD ya, corte por energía directo.
    const { stopped } = await speakAndFeed(session, { chunks: 4 });
    expect(stopped).toBe(true);
    expect(calls).toBe(3);
  });

  it('tras un rechazo hay cooldown: ruido continuo no re-chequea hasta rearmar', async () => {
    let calls = 0;
    const { session } = build({
      vadRecheckMs: 1000,
      vad: async () => {
        calls++;
        return 0.05;
      },
    });
    let stopped = false;
    const p = session.speak(
      async (ctl) => {
        for (let i = 0; i < 400 && !ctl.interrupted(); i++) await tick();
      },
      {
        stop: () => {
          stopped = true;
        },
      },
    );
    // Ruido fuerte continuo: dispara el primer chequeo (4 chunks de sostén).
    feedN(session, () => voice(0.2), 4);
    await settle();
    expect(calls).toBe(1);
    // 5 chunks más dentro del cooldown (500ms < 1000ms): sin segundo chequeo.
    feedN(session, () => voice(0.2), 5);
    await settle();
    expect(calls).toBe(1);
    // 7 chunks más (1,2s total desde el rechazo): cooldown pasado, sostén completo -> re-chequea.
    feedN(session, () => voice(0.2), 7);
    await settle();
    expect(calls).toBe(2);
    expect(stopped).toBe(false);
    expect(session.stats().bargeVadRejected).toBe(2);
    session.close('apagado');
    await p;
  });

  it('un chequeo que resuelve cuando ya no habla se descarta sin contar', async () => {
    let release: (prob: number) => void = () => {};
    const { session } = build({
      vad: () =>
        new Promise<number>((r) => {
          release = r;
        }),
    });
    // El run acaba solo (5 ticks) antes de que el VAD responda.
    const p = session.speak(
      async () => {
        for (let i = 0; i < 5; i++) await tick();
      },
      { stop: () => {} },
    );
    feedN(session, () => voice(0.2), 4);
    await settle();
    const outcome = await p;
    expect(outcome).toBe('fin');
    release(0.99);
    await settle();
    const st = session.stats();
    expect(st.bargeIns).toBe(0);
    expect(st.bargeVadRejected).toBe(0);
    expect(session.state()).toBe('escuchando');
  });

  it('sin VAD el comportamiento es el de siempre (corte por energía)', async () => {
    const { session, heard } = build({ transcribe: 'qué hora es' });
    const { stopped } = await speakAndFeed(session, { chunks: 4 });
    expect(stopped).toBe(true);
    feedN(session, quiet, 10);
    await settle();
    expect(session.stats().bargeIns).toBe(1);
    expect(heard).toEqual(['qué hora es']);
  });
});

describe('cancelación hablada: para / espera / calla', () => {
  it.each(['espera', 'un momento', 'calla', 'cállate', 'para'])(
    '"%s" cierra la conversación, no abre un turno',
    async (word) => {
      const { session, heard } = build({ transcribe: word });
      feedN(session, () => voice(0.2), 4);
      feedN(session, quiet, 10);
      await settle();
      expect(heard).toEqual([]);
      expect(session.state()).toBe('cerrada');
    },
  );

  it('"espera que te cuente" NO es cierre: las frases con contenido abren turno', async () => {
    const { session, heard } = build({ transcribe: 'espera que te cuente una cosa' });
    feedN(session, () => voice(0.2), 4);
    feedN(session, quiet, 10);
    await settle();
    expect(heard).toEqual(['espera que te cuente una cosa']);
    expect(session.state()).not.toBe('cerrada');
  });
});

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('chequeo tardío de una reproducción muerta (canary del auditor A→B)', () => {
  /** Deferred VAD: cada llamada devuelve una promesa que el test resuelve a mano. */
  function deferredVad() {
    const pending: Array<{ resolve: (p: number) => void; reject: (e: Error) => void }> = [];
    const vad = (): Promise<number> =>
      new Promise<number>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    return { vad, pending };
  }

  /** Habla durante `ticks` y acaba sola; devuelve cuando el VAD ya puede ir tarde. */
  async function speakA(session: ConversationSession, ticks: number): Promise<void> {
    const p = session.speak(
      async () => {
        for (let i = 0; i < ticks; i++) await tick();
      },
      { stop: () => {} }, // sin stop no hay barge-in: el candidato nunca nace
    );
    feedN(session, () => voice(0.2), 4); // candidato de A: chequeo en vuelo
    await settle();
    await p;
  }

  it('A dispara candidato, A termina, B habla, el VAD de A resuelve 0.99: NO corta B ni cuenta nada', async () => {
    const { vad, pending } = deferredVad();
    const { session } = build({ vad });
    await speakA(session, 6);
    expect(pending.length).toBe(1); // el chequeo de A sigue en el aire

    let stoppedB = false;
    const pB = session.speak(
      async (ctl) => {
        for (let i = 0; i < 200 && !ctl.interrupted(); i++) await tick();
      },
      {
        stop: () => {
          stoppedB = true;
        },
      },
    );
    feedN(session, () => voice(0.2), 4); // candidato de B: chequeo nuevo
    await settle();
    expect(pending.length).toBe(2);

    // El chequeo de A resuelve TARDE con habla clara: debe morir entero.
    pending[0]?.resolve(0.99);
    await settle();
    expect(stoppedB).toBe(false);
    let st = session.stats();
    expect(st.bargeIns).toBe(0);
    expect(st.bargeVadRejected).toBe(0);
    expect(st.lastError).toBe('');

    // El chequeo de B, el vivo, sí manda sobre B: rechazo contado y sin corte.
    pending[1]?.resolve(0.05);
    await settle();
    st = session.stats();
    expect(st.bargeVadRejected).toBe(1);
    expect(st.bargeIns).toBe(0);
    expect(stoppedB).toBe(false);
    session.close('apagado');
    await pB;
  });

  it('un ERROR tardío de A no toca vadErrors/lastError ni corta B; el chequeo vivo de B sí corta', async () => {
    const { vad, pending } = deferredVad();
    const { session } = build({ vad });
    await speakA(session, 6);

    let stoppedB = false;
    const pB = session.speak(
      async (ctl) => {
        for (let i = 0; i < 200 && !ctl.interrupted(); i++) await tick();
      },
      {
        stop: () => {
          stoppedB = true;
        },
      },
    );
    feedN(session, () => voice(0.2), 4);
    await settle();
    expect(pending.length).toBe(2);

    pending[0]?.reject(new Error('onnx tardío'));
    await settle();
    expect(stoppedB).toBe(false);
    expect(session.stats().lastError).toBe('');
    expect(session.stats().bargeIns).toBe(0);

    pending[1]?.resolve(0.99);
    await settle();
    expect(stoppedB).toBe(true);
    expect(session.stats().bargeIns).toBe(1);
    session.close('apagado');
    await pB;
  });
});

describe('plazo del chequeo VAD (scorer colgado)', () => {
  it('un scorer que no responde corta por energía al plazo, libera el hueco y la siguiente reproducción chequea de nuevo', async () => {
    let calls = 0;
    const { session } = build({
      vadTimeoutMs: 30,
      vad: () => {
        calls++;
        return new Promise<number>(() => {}); // nunca resuelve
      },
    });
    // Primer candidato: sin respuesta en 30ms el fallback de energía corta.
    const first = await speakAndFeed(session, { chunks: 4 });
    expect(first.stopped).toBe(true);
    expect(first.outcome).toBe('interrumpido');
    expect(session.stats().lastError).toMatch(/no respondió en 30ms/);
    expect(calls).toBe(1);
    feedN(session, quiet, 10);
    await settle();

    // El hueco quedó libre: el candidato de la siguiente reproducción chequea
    // otra vez (y también cae por plazo); sin plazo esto quedaría ignorado.
    const second = await speakAndFeed(session, { chunks: 4 });
    await wait(60);
    expect(calls).toBe(2);
    expect(second.stopped).toBe(true);
    session.close('apagado');
  });

  it('la respuesta que llega DESPUÉS del plazo no actúa: ni corta ni toca contadores', async () => {
    let release: (p: number) => void = () => {};
    const { session } = build({
      vadTimeoutMs: 30,
      vad: () =>
        new Promise<number>((r) => {
          release = r;
        }),
    });
    // El plazo corta por energía primero.
    const first = await speakAndFeed(session, { chunks: 4 });
    expect(first.stopped).toBe(true);
    expect(session.stats().bargeIns).toBe(1);
    const rejectedBefore = session.stats().bargeVadRejected;
    // Y cuando el scorer por fin responde (rechazo), ya no hay candidato vivo.
    release(0.01);
    await settle();
    expect(session.stats().bargeVadRejected).toBe(rejectedBefore);
    expect(session.stats().bargeIns).toBe(1);
    session.close('apagado');
  });
});
