/**
 * Métrica de falsos disparos del corte por voz (item 11, D1): cada sesión con
 * corte activado deja una fila — cuántas interrupciones hubo y cómo acabó la
 * frase que las sembró (turno real, ruido descartado o eco de la propia voz).
 * Con el acumulado de semanas se decide si el corte puede ser el defecto;
 * hasta entonces el defecto sigue siendo 'off' y esta tabla solo informa.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface BargeSessionRow {
  endedAt: number;
  level: string;
  bargeIns: number;
  trueIns: number;
  falseNoise: number;
  falseEcho: number;
  /** Sembradas que no llegaron a clasificarse (corte, error STT, timeout). */
  unclassified: number;
  utterances: number;
}

export interface BargeTotals {
  sessions: number;
  bargeIns: number;
  trueIns: number;
  falseNoise: number;
  falseEcho: number;
  unclassified: number;
}

export class BargeStats {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(
      'CREATE TABLE IF NOT EXISTS barge_sessions (' +
        'ended_at INTEGER NOT NULL, level TEXT NOT NULL, barge_ins INTEGER NOT NULL, ' +
        'true_ins INTEGER NOT NULL, false_noise INTEGER NOT NULL, false_echo INTEGER NOT NULL, ' +
        'unclassified INTEGER NOT NULL, utterances INTEGER NOT NULL)',
    );
    // DBs creadas antes de la columna: alta aditiva con 0 (desconocido, honesto).
    const cols = (
      this.db.prepare('PRAGMA table_info(barge_sessions)').all() as { name: string }[]
    ).map((c) => c.name);
    if (!cols.includes('unclassified')) {
      this.db.exec('ALTER TABLE barge_sessions ADD COLUMN unclassified INTEGER NOT NULL DEFAULT 0');
      // Las filas v1 no contaban lo sembrado sin clasificar: recuperarlo por
      // diferencia, o una fila vieja con huecos mostraria cobertura completa
      // falsa (cortes = clases + desconocidas debe cuadrar en el historico).
      this.db.exec(
        'UPDATE barge_sessions SET unclassified = MAX(0, barge_ins - true_ins - false_noise - false_echo)',
      );
    }
  }

  record(row: BargeSessionRow): void {
    this.db
      .prepare(
        'INSERT INTO barge_sessions (ended_at, level, barge_ins, true_ins, false_noise, false_echo, unclassified, utterances) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.endedAt,
        row.level,
        row.bargeIns,
        row.trueIns,
        row.falseNoise,
        row.falseEcho,
        row.unclassified,
        row.utterances,
      );
  }

  totals(sinceMs = 0): BargeTotals {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS sessions, COALESCE(SUM(barge_ins), 0) AS barge_ins, ' +
          'COALESCE(SUM(true_ins), 0) AS true_ins, COALESCE(SUM(false_noise), 0) AS false_noise, ' +
          'COALESCE(SUM(false_echo), 0) AS false_echo, COALESCE(SUM(unclassified), 0) AS unclassified ' +
          'FROM barge_sessions WHERE ended_at >= ?',
      )
      .get(sinceMs) as {
      sessions: number;
      barge_ins: number;
      true_ins: number;
      false_noise: number;
      false_echo: number;
      unclassified: number;
    };
    return {
      sessions: r.sessions,
      bargeIns: r.barge_ins,
      trueIns: r.true_ins,
      falseNoise: r.false_noise,
      falseEcho: r.false_echo,
      unclassified: r.unclassified,
    };
  }
}

/** Interrupciones con clase conocida (estimada por el transcript, no ground truth). */
export function bargeClassified(t: BargeTotals): number {
  return t.trueIns + t.falseNoise + t.falseEcho;
}

/**
 * Falsas estimadas sobre las CLASIFICADAS; null si ninguna tiene clase. Las sin
 * clasificar nunca entran en el denominador: sería sesgo a favor del corte.
 */
export function bargeFalseRate(t: BargeTotals): number | null {
  const classified = bargeClassified(t);
  if (classified === 0) return null;
  return (t.falseNoise + t.falseEcho) / classified;
}
