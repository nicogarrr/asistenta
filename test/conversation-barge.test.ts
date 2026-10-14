import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { BargeStats, bargeFalseRate } from '../src/voice/barge-stats.js';
import { ConversationSession, SAMPLE_RATE } from '../src/voice/conversation.js';
import { buildWeeklySummary } from '../src/weekly.js';

/** Chunks de 100 ms: el reloj es el audio alimentado, no el de pared. */
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

function build(over: { bargeIn?: 'off' | 'altavoces' | 'auriculares'; transcribe?: string } = {}) {
  const heard: string[] = [];
  const session = new ConversationSession({
    bargeIn: over.bargeIn ?? 'auriculares',
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
 * Pone la sesión a hablar y alimenta sonido sostenido por encima del umbral.
 * El run habla hasta que le interrumpen (o hasta agotar vueltas si nadie lo hace).
 */
async function speakAndFeed(
  session: ConversationSession,
  opts: { text?: string; chunks?: number; amp?: number } = {},
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
  const outcome = await p;
  return { stopped, outcome };
}

describe('barge-in: métrica de falsos disparos (item 11)', () => {
  it('ruido sostenido interrumpe y la frase sembrada descartada cuenta como falso disparo', async () => {
    const { session, heard } = build({ transcribe: 'eh' });
    const { stopped } = await speakAndFeed(session, { chunks: 4 });
    expect(stopped).toBe(true);
    expect(session.state()).toBe('escuchando');
    feedN(session, quiet, 10);
    await settle();
    const st = session.stats();
    expect(st.bargeIns).toBe(1);
    expect(st.bargeFalseNoise).toBe(1);
    expect(st.bargeFalseEcho).toBe(0);
    expect(st.bargeTrue).toBe(0);
    expect(heard).toEqual([]);
  });

  it('una interrupción real cuenta como verdadera y llega a turno', async () => {
    const { session, heard } = build({ transcribe: 'qué hora es' });
    await speakAndFeed(session, { chunks: 4 });
    feedN(session, quiet, 10);
    await settle();
    const st = session.stats();
    expect(st.bargeIns).toBe(1);
    expect(st.bargeTrue).toBe(1);
    expect(st.bargeFalseNoise).toBe(0);
    expect(heard).toEqual(['qué hora es']);
  });

  it('oirse a sí mismo cuenta falso por eco y a la segunda se apaga el corte', async () => {
    const text = 'la cartera sube un tres por ciento hoy';
    const { session } = build({ transcribe: 'la cartera sube un tres por ciento' });
    await speakAndFeed(session, { text, chunks: 4 });
    feedN(session, quiet, 10);
    await settle();
    expect(session.stats().bargeFalseEcho).toBe(1);
    expect(session.stats().bargeTrue).toBe(0);
    // Segunda vez seguida: los altavoces alimentan el micro y el corte se desactiva.
    await speakAndFeed(session, { text, chunks: 4 });
    feedN(session, quiet, 10);
    await settle();
    expect(session.stats().bargeFalseEcho).toBe(2);
    // Ya apagado: aunque grite, no interrumpe.
    const { stopped } = await speakAndFeed(session, { text, chunks: 6, amp: 0.6 });
    expect(stopped).toBe(false);
    expect(session.stats().bargeIns).toBe(2);
  });

  it('ruido sin interrupción previa no cuenta como falso disparo', async () => {
    const { session } = build({ transcribe: 'eh' });
    feedN(session, () => voice(), 5);
    feedN(session, quiet, 10);
    await settle();
    const st = session.stats();
    expect(st.bargeIns).toBe(0);
    expect(st.bargeFalseNoise).toBe(0);
    expect(st.bargeTrue).toBe(0);
  });

  it('altavoces: el eco medido no dispara; una voz claramente más fuerte sí', async () => {
    const { session } = build({ bargeIn: 'altavoces', transcribe: 'qué hora es' });
    // Misma energía que el eco de la sala: umbral = 2x eco, no dispara.
    const first = await speakAndFeed(session, { chunks: 10, amp: 0.2 });
    expect(first.stopped).toBe(false);
    expect(session.stats().bargeIns).toBe(0);
    // El usuario habla a mitad de frase, DESPUÉS de la calibración (si hablara
    // justo al empezar la frase, su voz se mediría como eco: límite declarado).
    let stopped = false;
    const p = session.speak(
      async (ctl) => {
        for (let i = 0; i < 200 && !ctl.interrupted(); i++) await tick();
      },
      {
        stop: () => {
          stopped = true;
        },
      },
    );
    feedN(session, () => voice(0.2), 5); // eco de la frase: calibra
    feedN(session, () => voice(0.6), 4); // el usuario habla encima, muy por encima del umbral
    await p;
    expect(stopped).toBe(true);
    expect(session.stats().bargeIns).toBe(1);
  });
});

describe('BargeStats (persistencia)', () => {
  it('acumula por periodo y la tasa sin interrupciones es null, no 0', () => {
    const db = new DatabaseSync(':memory:');
    const stats = new BargeStats(db);
    expect(bargeFalseRate(stats.totals())).toBeNull();
    const now = 1_800_000_000_000;
    stats.record({
      endedAt: now - 1000,
      level: 'auriculares',
      bargeIns: 4,
      trueIns: 3,
      falseNoise: 1,
      falseEcho: 0,
      utterances: 9,
    });
    stats.record({
      endedAt: now,
      level: 'altavoces',
      bargeIns: 2,
      trueIns: 1,
      falseNoise: 0,
      falseEcho: 1,
      utterances: 5,
    });
    const all = stats.totals();
    expect(all.sessions).toBe(2);
    expect(all.bargeIns).toBe(6);
    expect(all.trueIns).toBe(4);
    expect(bargeFalseRate(all)).toBeCloseTo(2 / 6);
    const onlyLast = stats.totals(now - 500);
    expect(onlyLast.sessions).toBe(1);
    expect(onlyLast.bargeIns).toBe(2);
    db.close();
  });
});

describe('resumen semanal', () => {
  it('incluye la línea de cortes solo si hubo interrupciones', () => {
    const base = {
      entries: [],
      now: 1_800_000_000_000,
      pending: '',
      watching: 0,
    };
    expect(buildWeeklySummary(base)).not.toContain('Interrupciones de voz');
    const out = buildWeeklySummary({
      ...base,
      barge: { sessions: 1, bargeIns: 4, trueIns: 3, falseNoise: 1, falseEcho: 0 },
    });
    expect(out).toContain('Interrupciones de voz (corte): 4 (3 reales, 25% falsos disparos).');
  });
});
