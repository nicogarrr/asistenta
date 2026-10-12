/**
 * Ojo de águila, parte 3a: seguimiento de lo descubierto en el correo.
 *
 * El correo solo se lee hacia atrás unos días, pero una caducidad avisa a 30, 7 y 1 día:
 * cuando el correo sale de la ventana, el hallazgo desaparece de la agenda y los
 * recordatorios nunca saldrían. Lo ya avisado por correo se guarda aquí y se usa SOLO para
 * sus recordatorios. Solo se siguen cosas de origen correo: las del calendario y los
 * pendientes reaparecen mientras sean vigentes, y un evento cancelado no debe recordarse.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { AgendaItem } from './agenda/unified.js';
import { occurrenceKey } from './ojo.js';

const DAY_MS = 86_400_000;

export function initTrackStore(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vigilante_tracked (
      occ_key TEXT PRIMARY KEY,
      item TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

export function trackable(item: AgendaItem): boolean {
  return item.where === 'correo' && item.at != null && !item.sources?.some((s) => s !== 'correo');
}

export function trackItems(db: DatabaseSync, items: readonly AgendaItem[], now: number): void {
  initTrackStore(db);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO vigilante_tracked (occ_key, item, due_at, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const item of items) {
    if (!trackable(item)) continue;
    ins.run(occurrenceKey(item), JSON.stringify(item), (item.at as number) + DAY_MS, now);
  }
}

/** Elementos seguidos aún vigentes; descarta de la base los ya vencidos. */
export function loadTracked(db: DatabaseSync, now: number): AgendaItem[] {
  initTrackStore(db);
  db.prepare('DELETE FROM vigilante_tracked WHERE due_at < ?').run(now - DAY_MS);
  const rows = db
    .prepare('SELECT item FROM vigilante_tracked WHERE due_at >= ?')
    .all(now) as Array<{
    item: string;
  }>;
  const out: AgendaItem[] = [];
  for (const r of rows) {
    try {
      const it = JSON.parse(r.item) as AgendaItem;
      if (it && typeof it.title === 'string' && typeof it.at === 'number') out.push(it);
    } catch {
      // fila corrupta: se ignora
    }
  }
  return out;
}
