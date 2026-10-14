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
  utterances: number;
}

export interface BargeTotals {
  sessions: number;
  bargeIns: number;
  trueIns: number;
  falseNoise: number;
  falseEcho: number;
}

export class BargeStats {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(
      'CREATE TABLE IF NOT EXISTS barge_sessions (' +
        'ended_at INTEGER NOT NULL, level TEXT NOT NULL, barge_ins INTEGER NOT NULL, ' +
        'true_ins INTEGER NOT NULL, false_noise INTEGER NOT NULL, false_echo INTEGER NOT NULL, ' +
        'utterances INTEGER NOT NULL)',
    );
  }

  record(row: BargeSessionRow): void {
    this.db
      .prepare(
        'INSERT INTO barge_sessions (ended_at, level, barge_ins, true_ins, false_noise, false_echo, utterances) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.endedAt,
        row.level,
        row.bargeIns,
        row.trueIns,
        row.falseNoise,
        row.falseEcho,
        row.utterances,
      );
  }

  totals(sinceMs = 0): BargeTotals {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS sessions, COALESCE(SUM(barge_ins), 0) AS barge_ins, ' +
          'COALESCE(SUM(true_ins), 0) AS true_ins, COALESCE(SUM(false_noise), 0) AS false_noise, ' +
          'COALESCE(SUM(false_echo), 0) AS false_echo FROM barge_sessions WHERE ended_at >= ?',
      )
      .get(sinceMs) as {
      sessions: number;
      barge_ins: number;
      true_ins: number;
      false_noise: number;
      false_echo: number;
    };
    return {
      sessions: r.sessions,
      bargeIns: r.barge_ins,
      trueIns: r.true_ins,
      falseNoise: r.false_noise,
      falseEcho: r.false_echo,
    };
  }
}

/** Falsos disparos por interrupción, o null sin interrupciones: 0 sin datos no es un 0 real. */
export function bargeFalseRate(t: BargeTotals): number | null {
  if (t.bargeIns === 0) return null;
  return (t.falseNoise + t.falseEcho) / t.bargeIns;
}
