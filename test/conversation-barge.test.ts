import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { BargeStats, bargeClassified, bargeFalseRate } from '../src/voice/barge-stats.js';
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

function build(
  over: {
    bargeIn?: 'off' | 'altavoces' | 'auriculares';
    transcribe?: string;
    transcribeImpl?: (samples: Float32Array) => Promise<string>;
    minVoicedMs?: number;
    transcribeTimeoutMs?: number;
  } = {},
) {
  const heard: string[] = [];
  const session = new ConversationSession({
    bargeIn: over.bargeIn ?? 'auriculares',
    tailMs: 0,
    minVoicedMs: over.minVoicedMs,
    transcribeTimeoutMs: over.transcribeTimeoutMs,
    transcriber: over.transcribeImpl ?? (async () => over.transcribe ?? 'qué hora es'),
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
    expect(st.bargeUnclassified).toBe(0);
    expect(heard).toEqual([]);
  });

  it('una interrupción con turno al final cuenta como uso estimado', async () => {
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

  it('STT que falla tras la interrupción: sin clasificar, y un submit ajeno no hereda la marca', async () => {
    let calls = 0;
    const { session, heard } = build({
      transcribeImpl: async () => {
        calls++;
        if (calls === 1) throw new Error('whisper caído');
        return 'qué hora es';
      },
    });
    await speakAndFeed(session, { chunks: 4 });
    feedN(session, quiet, 10);
    await settle();
    let st = session.stats();
    expect(st.bargeIns).toBe(1);
    expect(st.bargeUnclassified).toBe(1);
    expect(st.bargeTrue).toBe(0);
    expect(st.bargeFalseNoise).toBe(0);
    // Un texto suministrado después NO es la frase interrumpida: no hereda clase.
    await session.submit('qué hora es');
    await settle();
    st = session.stats();
    expect(st.bargeTrue).toBe(0);
    expect(st.bargeUnclassified).toBe(1);
    expect(heard).toEqual(['qué hora es']);
  });

  it('cerrar la sesión antes de transcribir lo deja sin clasificar', async () => {
    const { session } = build({});
    await speakAndFeed(session, { chunks: 4 });
    session.close('cierre');
    const st = session.stats();
    expect(st.bargeIns).toBe(1);
    expect(st.bargeUnclassified).toBe(1);
    expect(st.bargeTrue).toBe(0);
    expect(st.bargeFalseNoise).toBe(0);
  });

  it('timeout de STT: sin clasificar y el resultado tardío no reclasifica', async () => {
    let resolveLate: (t: string) => void = () => {};
    const { session } = build({
      transcribeTimeoutMs: 50,
      transcribeImpl: () =>
        new Promise<string>((r) => {
          resolveLate = r;
        }),
    });
    await speakAndFeed(session, { chunks: 4 });
    feedN(session, quiet, 10);
    await settle();
    await new Promise((r) => setTimeout(r, 150));
    await settle();
    let st = session.stats();
    expect(st.bargeUnclassified).toBe(1);
    expect(st.bargeTrue).toBe(0);
    // El whisper tardío llega después: no cambia la contabilidad.
    resolveLate('qué hora es');
    await settle();
    st = session.stats();
    expect(st.bargeUnclassified).toBe(1);
    expect(st.bargeTrue).toBe(0);
    expect(st.utterances).toBe(0);
  });

  it('con el transcript en vuelo la sembrada figura pendiente, ni clasificada ni desconocida', async () => {
    const { session } = build({
      transcribeTimeoutMs: 60_000,
      transcribeImpl: () => new Promise<string>(() => {}), // nunca resuelve
    });
    await speakAndFeed(session, { chunks: 4 });
    feedN(session, quiet, 10);
    await settle();
    let st = session.stats();
    expect(st.bargeIns).toBe(1);
    expect(st.bargePending).toBe(1);
    expect(st.bargeUnclassified).toBe(0);
    expect(st.bargeTrue).toBe(0);
    // Al cerrar, la pendiente pasa a sin clasificar y la suma cuadra.
    session.close('cierre');
    st = session.stats();
    expect(st.bargePending).toBe(0);
    expect(st.bargeUnclassified).toBe(1);
    expect(st.bargeIns).toBe(
      st.bargeTrue +
        st.bargeFalseNoise +
        st.bargeFalseEcho +
        st.bargeUnclassified +
        st.bargePending,
    );
  });

  it('sonido que interrumpe pero no llega a frase hablada: sin clasificar', async () => {
    const { session } = build({ minVoicedMs: 600 });
    await speakAndFeed(session, { chunks: 4 }); // ~400 ms con voz: bajo el mínimo de 600
    feedN(session, quiet, 10);
    await settle();
    const st = session.stats();
    expect(st.bargeIns).toBe(1);
    expect(st.bargeUnclassified).toBe(1);
    expect(st.bargeTrue).toBe(0);
    expect(st.bargeFalseNoise).toBe(0);
  });
});

describe('BargeStats (persistencia)', () => {
  it('acumula por periodo; la tasa va solo sobre clasificadas y sin ellas es null', () => {
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
      unclassified: 2,
      utterances: 9,
    });
    stats.record({
      endedAt: now,
      level: 'altavoces',
      bargeIns: 2,
      trueIns: 1,
      falseNoise: 0,
      falseEcho: 1,
      unclassified: 0,
      utterances: 5,
    });
    const all = stats.totals();
    expect(all.sessions).toBe(2);
    expect(all.bargeIns).toBe(6);
    expect(all.trueIns).toBe(4);
    expect(all.unclassified).toBe(2);
    // 2 falsas estimadas sobre 6 clasificadas; las 2 sin clasificar NO entran.
    expect(bargeClassified(all)).toBe(6);
    expect(bargeFalseRate(all)).toBeCloseTo(2 / 6);
    const onlyLast = stats.totals(now - 500);
    expect(onlyLast.sessions).toBe(1);
    expect(onlyLast.bargeIns).toBe(2);
    db.close();
  });

  it('migra una DB v1: lo sembrado sin clasificar se recupera por diferencia', () => {
    const db = new DatabaseSync(':memory:');
    // Esquema v1 (ronda 1 del item 11): sin columna unclassified.
    db.exec(
      'CREATE TABLE barge_sessions (ended_at INTEGER NOT NULL, level TEXT NOT NULL, barge_ins INTEGER NOT NULL, true_ins INTEGER NOT NULL, false_noise INTEGER NOT NULL, false_echo INTEGER NOT NULL, utterances INTEGER NOT NULL)',
    );
    const insert = db.prepare(
      'INSERT INTO barge_sessions (ended_at, level, barge_ins, true_ins, false_noise, false_echo, utterances) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    // Canario del auditor: 3 cortes, 1 clasificada, hueco de 2.
    insert.run(1, 'altavoces', 3, 1, 0, 0, 5);
    // Fila sin hueco: no debe inventar desconocidas.
    insert.run(2, 'auriculares', 2, 1, 1, 0, 4);
    const stats = new BargeStats(db);
    const t = stats.totals();
    expect(t.bargeIns).toBe(5);
    expect(bargeClassified(t)).toBe(3);
    expect(t.unclassified).toBe(2);
    expect(bargeFalseRate(t)).toBeCloseTo(1 / 3);
    // En DB cerrada cuadra: cortes = clases + desconocidas.
    expect(t.bargeIns).toBe(bargeClassified(t) + t.unclassified);
    db.close();
  });

  it('migracion atomica: si el backfill falla, la columna se revierte y el retry la completa', () => {
    const db = new DatabaseSync(':memory:');
    // Esquema v1 con una fila con hueco (3 cortes, 1 clasificada).
    db.exec(
      'CREATE TABLE barge_sessions (ended_at INTEGER NOT NULL, level TEXT NOT NULL, barge_ins INTEGER NOT NULL, true_ins INTEGER NOT NULL, false_noise INTEGER NOT NULL, false_echo INTEGER NOT NULL, utterances INTEGER NOT NULL)',
    );
    db.prepare(
      'INSERT INTO barge_sessions (ended_at, level, barge_ins, true_ins, false_noise, false_echo, utterances) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(1, 'altavoces', 3, 1, 0, 0, 5);
    // Canario del auditor: el UPDATE del backfill aborta tras el ALTER.
    db.exec(
      "CREATE TRIGGER fail_backfill BEFORE UPDATE ON barge_sessions BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    expect(() => new BargeStats(db)).toThrow();
    // La migracion fallo entera: la columna no queda creada a medias.
    const cols = (db.prepare('PRAGMA table_info(barge_sessions)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('unclassified');
    // Sin el fallo, el retry migra y rellena: 2 sin clasificar.
    db.exec('DROP TRIGGER fail_backfill');
    const stats = new BargeStats(db);
    expect(stats.totals().unclassified).toBe(2);
    db.close();
  });

  it('sin nada clasificado la tasa es null aunque haya interrupciones', () => {
    const db = new DatabaseSync(':memory:');
    const stats = new BargeStats(db);
    stats.record({
      endedAt: 1,
      level: 'auriculares',
      bargeIns: 3,
      trueIns: 0,
      falseNoise: 0,
      falseEcho: 0,
      unclassified: 3,
      utterances: 0,
    });
    const t = stats.totals();
    expect(t.bargeIns).toBe(3);
    expect(bargeClassified(t)).toBe(0);
    expect(bargeFalseRate(t)).toBeNull();
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
      barge: { sessions: 1, bargeIns: 4, trueIns: 3, falseNoise: 1, falseEcho: 0, unclassified: 0 },
    });
    expect(out).toContain(
      'Interrupciones de voz (corte): 4 (4 clasificadas: 3 uso estimado, 25% falsas estimadas).',
    );
  });
});
