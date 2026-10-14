/**
 * Resumen semanal de Asistenta: qué ha hecho esta semana, con datos propios.
 *
 * No lee email, calendario ni banco: solo su registro de acciones, sus vigilancias y
 * sus pendientes. Si no hubo nada, lo dice en una línea en vez de rellenar.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { ActionEntry } from './audit/log.js';

const WEEK_MS = 7 * 24 * 3_600_000;

export interface WeeklyInput {
  entries: ActionEntry[];
  now: number;
  /** Texto de /pendientes ya resumido, o '' si no hay. */
  pending: string;
  watching: number;
  /** Bloque extra ya redactado (p. ej. el resumen de gimnasio). */
  extra?: string;
}

export function buildWeeklySummary(i: WeeklyInput): string {
  const since = i.now - WEEK_MS;
  const week = i.entries.filter((e) => {
    const at = Date.parse(e.ts);
    return Number.isFinite(at) && at >= since && at <= i.now;
  });
  const turns = week.filter((e) => e.action === 'turn');
  const failed = turns.filter((e) => e.result === 'error').length;
  const downloads = week.filter((e) => e.action === 'descarga');
  const downloadsFailed = downloads.filter((e) => e.result === 'error').length;
  const changes = week.filter((e) => e.action === 'vigila_cambio').length;
  const lines = ['Resumen de la semana:'];
  if (turns.length === 0 && changes === 0 && downloads.length === 0) {
    lines.push('- No hemos hablado ni he detectado cambios esta semana.');
  } else {
    lines.push(
      `- Peticiones atendidas: ${turns.length}${failed ? ` (${failed} fallaron)` : ', todas sin error'}.`,
    );
    if (downloads.length) {
      lines.push(
        `- Descargas: ${downloads.length - downloadsFailed} enviadas${downloadsFailed ? `, ${downloadsFailed} fallaron` : ''}.`,
      );
    }
    if (changes) lines.push(`- Cambios detectados en páginas vigiladas: ${changes}.`);
    // Disparador (a) del multi-agente en ROADMAP.md: que Asistenta haga builds
    // grandes multi-archivo de forma habitual. Este contador es la medicion
    // semanal de ese disparador; el 0 tambien es dato.
    const builds = week.filter((e) => e.action === 'build_multi').length;
    lines.push(`- Builds multi-archivo (2+ archivos escritos en una petición): ${builds}.`);
  }
  lines.push(`- Páginas que vigilo ahora: ${i.watching}.`);
  if (i.extra?.trim()) lines.push('', i.extra.trim());
  if (i.pending.trim()) lines.push('', i.pending.trim());
  return lines.join('\n');
}

/** Domingo desde las 18:00 hora local y sin haberlo enviado en los últimos 6 días. */
export function isWeeklyDue(now: Date, lastSentMs: number): boolean {
  return (
    now.getDay() === 0 && now.getHours() >= 18 && now.getTime() - lastSentMs > 6 * 24 * 3_600_000
  );
}

/** Memoria mínima de cuándo se envió el último, para no repetir tras reiniciar. */
export class WeeklyState {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(
      'CREATE TABLE IF NOT EXISTS weekly_state (scope TEXT PRIMARY KEY, last_sent INTEGER NOT NULL)',
    );
  }
  lastSent(scope: string): number {
    const r = this.db.prepare('SELECT last_sent FROM weekly_state WHERE scope = ?').get(scope) as
      | { last_sent: number }
      | undefined;
    return r ? Number(r.last_sent) : 0;
  }
  markSent(scope: string, at: number): void {
    this.db
      .prepare(
        'INSERT INTO weekly_state (scope, last_sent) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET last_sent = excluded.last_sent',
      )
      .run(scope, at);
  }
}
