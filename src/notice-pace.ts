/**
 * Ritmo de avisos proactivos. Solo puede BAJAR respecto a los límites ya revisados
 * del filtro de eventos (4 avisos/24 h, 30 min entre avisos): nunca los sube.
 *
 * - Explícito: `/avisos menos|minimo|normal`.
 * - Adaptativo: 3 avisos descartados con /ignora en 48 h bajan un nivel y se le dice
 *   al dueño; volver a subir solo lo hace él con `/avisos normal`.
 * No lee contenido de avisos ni de correo; solo cuenta descartes con su hora.
 */
import type { DatabaseSync } from 'node:sqlite';
import { ATTENTION_LIMITS } from './ojo-events.js';

export type Pace = 'normal' | 'menos' | 'minimo';
const ORDER: Pace[] = ['normal', 'menos', 'minimo'];
const HOUR = 3_600_000;
export const PACE_LIMITS: Record<Pace, { noticesPerDay: number; cooldownMs: number }> = {
  normal: {
    noticesPerDay: ATTENTION_LIMITS.noticesPerDay,
    cooldownMs: ATTENTION_LIMITS.cooldownMs,
  },
  menos: { noticesPerDay: 2, cooldownMs: 2 * HOUR },
  minimo: { noticesPerDay: 1, cooldownMs: 8 * HOUR },
};
export const AUTO_STEP_DISMISSALS = 3;
export const AUTO_STEP_WINDOW_MS = 48 * HOUR;

function init(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS notice_pace (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notice_dismissals (at INTEGER NOT NULL);`);
}

export function getPace(db: DatabaseSync): Pace {
  init(db);
  const row = db.prepare("SELECT value FROM notice_pace WHERE key='level'").get() as
    | { value: string }
    | undefined;
  return ORDER.includes(row?.value as Pace) ? (row?.value as Pace) : 'normal';
}

export function setPace(db: DatabaseSync, pace: Pace): void {
  init(db);
  db.prepare(
    "INSERT INTO notice_pace(key,value) VALUES ('level',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(pace);
  db.exec('DELETE FROM notice_dismissals');
}

export function currentLimits(db: DatabaseSync) {
  return PACE_LIMITS[getPace(db)];
}

/** Parse the argument of /avisos. Accepts accents and a few plain-Spanish synonyms. */
export function parsePace(arg: string): Pace | 'estado' | null {
  const a = arg
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!a || a === 'estado') return 'estado';
  if (['normal', 'mas', 'como antes'].includes(a)) return 'normal';
  if (['menos', 'bajar', 'menos avisos'].includes(a)) return 'menos';
  if (['minimo', 'solo lo importante', 'casi nada'].includes(a)) return 'minimo';
  return null;
}

/** A dismissed notice is a signal that the pace is too high. Returns the new level if it stepped down. */
export function recordDismissal(db: DatabaseSync, now: number): Pace | null {
  init(db);
  db.prepare('DELETE FROM notice_dismissals WHERE at < ?').run(now - AUTO_STEP_WINDOW_MS);
  db.prepare('INSERT INTO notice_dismissals(at) VALUES (?)').run(now);
  const n = (db.prepare('SELECT count(*) AS n FROM notice_dismissals').get() as { n: number }).n;
  if (n < AUTO_STEP_DISMISSALS) return null;
  const idx = ORDER.indexOf(getPace(db));
  if (idx >= ORDER.length - 1) {
    db.exec('DELETE FROM notice_dismissals');
    return null;
  }
  const next = ORDER[idx + 1] as Pace;
  setPace(db, next);
  return next;
}

export function paceText(pace: Pace): string {
  const l = PACE_LIMITS[pace];
  const gap = l.cooldownMs / HOUR;
  return `Ritmo de avisos: ${pace}. Máximo ${l.noticesPerDay} aviso(s) del filtro de correo/citas cada 24 h, con al menos ${gap >= 1 ? `${gap} h` : '30 min'} entre ellos. Los recordatorios de plazos y pagos no cambian. /avisos menos | minimo | normal.`;
}
