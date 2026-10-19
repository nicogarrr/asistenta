// Brecha 3b: la puerta de hablante dentro de la conversación por voz.
// Audio capturado -> puerta ANTES de whisper: voz no enrolada no se transcribe
// ni se contesta; error de puerta = descarte (fail closed); el texto de
// submit() (viene del dueño por Telegram) nunca pasa por la puerta.
import { describe, expect, it } from 'vitest';
import { ConversationSession, SAMPLE_RATE } from '../src/voice/conversation.js';

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
  gate?: (samples: Float32Array) => Promise<boolean>;
  transcribeImpl?: (samples: Float32Array) => Promise<string>;
}) {
  const heard: string[] = [];
  let rejected = 0;
  const session = new ConversationSession({
    tailMs: 0,
    speakerGate: over.gate,
    onSpeakerRejected: () => {
      rejected++;
    },
    transcriber: over.transcribeImpl ?? (async () => 'qué hora es'),
    onUtterance: async (t) => {
      heard.push(t);
    },
    onClose: () => {},
  });
  return {
    session,
    heard,
    rejected: () => rejected,
  };
}

/** Una frase completa: voz sostenida y luego silencio que la cierra. */
const say = async (s: ConversationSession): Promise<void> => {
  feedN(s, () => voice(), 5);
  feedN(s, quiet, 10);
  await settle();
};

describe('conversación: puerta de hablante (brecha 3b)', () => {
  it('sin puerta todo fluye como antes (regresión)', async () => {
    const { session, heard } = build({});
    await say(session);
    expect(heard).toEqual(['qué hora es']);
  });

  it('voz aceptada: se transcribe y se contesta con normalidad', async () => {
    const { session, heard, rejected } = build({ gate: async () => true });
    await say(session);
    expect(heard).toEqual(['qué hora es']);
    expect(rejected()).toBe(0);
    expect(session.state()).toBe('escuchando');
  });

  it('voz no enrolada: NO se transcribe, no se contesta y cuenta el rechazo', async () => {
    let transcribed = 0;
    const { session, heard, rejected } = build({
      gate: async () => false,
      transcribeImpl: async () => {
        transcribed++;
        return 'qué hora es';
      },
    });
    await say(session);
    expect(heard).toEqual([]);
    expect(transcribed).toBe(0); // whisper nunca vio el audio
    expect(rejected()).toBe(1);
    // La sesión sigue viva y escuchando: una voz ajena no la tumba.
    expect(session.state()).toBe('escuchando');
  });

  it('la puerta recibe el audio capturado, no un buffer vacío', async () => {
    let got = 0;
    const { session, heard } = build({
      gate: async (samples) => {
        got = samples.length;
        return true;
      },
    });
    await say(session);
    // 5 chunks de voz (500 ms) + cola: suficiente para un embedding.
    expect(got).toBeGreaterThanOrEqual(SAMPLE_RATE / 2);
    expect(heard).toEqual(['qué hora es']);
  });

  it('error de la puerta: fail closed (descarta, avisa y sigue escuchando)', async () => {
    const { session, heard, rejected } = build({
      gate: async () => {
        throw new Error('extractor roto');
      },
    });
    await say(session);
    expect(heard).toEqual([]);
    expect(rejected()).toBe(1);
    expect(session.stats().lastError).toContain('no pude verificar la voz');
    expect(session.state()).toBe('escuchando');
  });

  it('submit() (texto del dueño) NO pasa por la puerta', async () => {
    let gateCalls = 0;
    const { session, heard } = build({
      gate: async () => {
        gateCalls++;
        return false; // aunque la puerta rechace todo
      },
    });
    await session.submit('apaga la tele');
    await settle();
    expect(heard).toEqual(['apaga la tele']);
    expect(gateCalls).toBe(0);
  });

  it('dos frases seguidas: cada una pasa su puerta, sin pisar el turno', async () => {
    const verdicts = [true, false];
    const { session, heard, rejected } = build({
      gate: async () => verdicts.shift() ?? true,
    });
    await say(session);
    await say(session);
    expect(heard).toEqual(['qué hora es']); // solo la primera
    expect(rejected()).toBe(1);
  });
});
