/**
 * Ojo de águila, parte 2: aprender qué ignoras.
 *
 * Cada aviso lleva un número `[#n]`. `/ignora n` descarta ese aviso concreto (deja
 * de recordarlo) y lo cuenta contra su CLASE: tipo + fuente + patrón del título
 * (palabras sin dígitos ni puntuación, las 4 primeras). Cuando dos avisos distintos
 * de una misma clase se han descartado, se PROPONE una regla; no se activa sola:
 * hasta que se acepta con `/ignorados activar <id>` nada cambia. Una regla activa
 * silencia el descubrimiento y los recordatorios de su clase, con una salvaguarda
 * fija: un pago o plazo con hora a menos de 2 h SE AVISA SIEMPRE, también si está
 * ignorado o con regla (un error de clasificación no puede costar un pago).
 *
 * Límites declarados: no hay remitente en la agenda unificada, así que la clase es
 * por fuente + patrón de título, no por persona; los conflictos no se filtran por
 * reglas; se guardan los últimos 500 avisos numerados.
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgendaItem } from './agenda/unified.js';
import { occurrenceKey } from './ojo.js';

export const MAX_NOTICES = 500;
export const DISMISSALS_TO_PROPOSE = 2;
const PATTERN_WORDS = 4;

export function initIgnoreStore(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vigilante_notices (
      n INTEGER PRIMARY KEY AUTOINCREMENT,
      occ_key TEXT NOT NULL,
      class_key TEXT,
      kind TEXT NOT NULL,
      src TEXT NOT NULL,
      title TEXT NOT NULL,
      at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS vigilante_dismissals (
      n INTEGER PRIMARY KEY,
      occ_key TEXT NOT NULL,
      class_key TEXT,
      counted INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS vigilante_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      src TEXT NOT NULL,
      pattern TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
}

/** Palabras del título sin acentos, dígitos ni puntuación; las primeras 4 de 2+ letras. */
export function titlePattern(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, PATTERN_WORDS)
    .join(' ');
}

export function classKey(item: AgendaItem): string | null {
  const pattern = titlePattern(item.title);
  if (!pattern) return null;
  return createHash('sha256')
    .update(`${item.kind}|${item.where}|${pattern}`)
    .digest('hex')
    .slice(0, 24);
}

/** Último número asignado (0 si no hay): los siguientes avisos usan base+1... */
export function lastNoticeNumber(db: DatabaseSync): number {
  initIgnoreStore(db);
  const row = db
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'vigilante_notices'")
    .get() as { seq: number } | undefined;
  return row?.seq ?? 0;
}

/** Guarda los avisos YA entregados con su número. */
export function recordNotices(
  db: DatabaseSync,
  entries: ReadonlyArray<{ n: number; item: AgendaItem }>,
  now: number,
): void {
  initIgnoreStore(db);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO vigilante_notices (n, occ_key, class_key, kind, src, title, at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  let max = 0;
  for (const { n, item } of entries) {
    ins.run(
      n,
      occurrenceKey(item),
      classKey(item),
      item.kind,
      item.where,
      item.title,
      item.at ?? null,
      now,
    );
    max = Math.max(max, n);
  }
  if (max > 0) db.prepare('DELETE FROM vigilante_notices WHERE n <= ?').run(max - MAX_NOTICES);
}

export interface Rule {
  id: number;
  kind: string;
  src: string;
  pattern: string;
  status: 'propuesta' | 'activa';
}

export function listRules(db: DatabaseSync): Array<Rule & { dismissed: number; classKey: string }> {
  initIgnoreStore(db);
  const rows = db
    .prepare(
      `SELECT r.id, r.kind, r.src, r.pattern, r.status, r.class_key AS classKey,
        (SELECT count(*) FROM vigilante_dismissals d WHERE d.class_key = r.class_key AND d.counted = 1) AS dismissed
       FROM vigilante_rules r ORDER BY r.id`,
    )
    .all() as unknown as Array<Rule & { dismissed: number; classKey: string }>;
  return rows;
}

export type DismissResult =
  | { ok: true; already: boolean; proposal: Rule | null; noClass: boolean; title: string }
  | { ok: false; error: string };

/** `/ignora n`: descarta ese aviso y cuenta contra su clase; propone regla a los 2 descartes. */
export function dismissNotice(db: DatabaseSync, n: number, now: number): DismissResult {
  initIgnoreStore(db);
  const notice = db.prepare('SELECT * FROM vigilante_notices WHERE n = ?').get(n) as
    | { occ_key: string; class_key: string | null; kind: string; src: string; title: string }
    | undefined;
  if (!notice) {
    return { ok: false, error: `No encuentro el aviso #${n} (guardo los últimos ${MAX_NOTICES}).` };
  }
  const exists = db.prepare('SELECT 1 AS x FROM vigilante_dismissals WHERE n = ?').get(n);
  if (exists) {
    return {
      ok: true,
      already: true,
      proposal: null,
      noClass: notice.class_key === null,
      title: notice.title,
    };
  }
  db.prepare(
    'INSERT INTO vigilante_dismissals (n, occ_key, class_key, counted, created_at) VALUES (?, ?, ?, 1, ?)',
  ).run(n, notice.occ_key, notice.class_key, now);
  let proposal: Rule | null = null;
  if (notice.class_key) {
    // Cuenta avisos DISTINTOS de la clase (ocurrencias distintas), no el mismo repetido.
    const count = (
      db
        .prepare(
          'SELECT count(DISTINCT occ_key) AS c FROM vigilante_dismissals WHERE class_key = ? AND counted = 1',
        )
        .get(notice.class_key) as { c: number }
    ).c;
    const has = db
      .prepare('SELECT 1 AS x FROM vigilante_rules WHERE class_key = ?')
      .get(notice.class_key);
    if (count >= DISMISSALS_TO_PROPOSE && !has) {
      const pattern = titlePattern(notice.title);
      const res = db
        .prepare(
          "INSERT INTO vigilante_rules (class_key, kind, src, pattern, status, created_at) VALUES (?, ?, ?, ?, 'propuesta', ?)",
        )
        .run(notice.class_key, notice.kind, notice.src, pattern, now);
      proposal = {
        id: Number(res.lastInsertRowid),
        kind: notice.kind,
        src: notice.src,
        pattern,
        status: 'propuesta',
      };
    }
  }
  return {
    ok: true,
    already: false,
    proposal,
    noClass: notice.class_key === null,
    title: notice.title,
  };
}

/** Activa una propuesta. Solo desde `propuesta`: activar es siempre una decisión explícita. */
export function activateRule(db: DatabaseSync, id: number): { ok: boolean; error?: string } {
  initIgnoreStore(db);
  const row = db.prepare('SELECT status FROM vigilante_rules WHERE id = ?').get(id) as
    | { status: string }
    | undefined;
  if (!row) return { ok: false, error: `No existe la regla ${id}.` };
  if (row.status === 'activa') return { ok: false, error: `La regla ${id} ya está activa.` };
  db.prepare("UPDATE vigilante_rules SET status = 'activa' WHERE id = ?").run(id);
  return { ok: true };
}

/** Borra la regla y reinicia el conteo de su clase (los avisos ya descartados siguen descartados). */
export function deleteRule(db: DatabaseSync, id: number): { ok: boolean; error?: string } {
  initIgnoreStore(db);
  const row = db.prepare('SELECT class_key FROM vigilante_rules WHERE id = ?').get(id) as
    | { class_key: string }
    | undefined;
  if (!row) return { ok: false, error: `No existe la regla ${id}.` };
  db.prepare('DELETE FROM vigilante_rules WHERE id = ?').run(id);
  db.prepare('UPDATE vigilante_dismissals SET counted = 0 WHERE class_key = ?').run(row.class_key);
  return { ok: true };
}

export interface IgnoreState {
  activeClasses: ReadonlySet<string>;
  dismissedOccurrences: ReadonlySet<string>;
}

export function loadIgnoreState(db: DatabaseSync): IgnoreState {
  initIgnoreStore(db);
  const active = (
    db.prepare("SELECT class_key FROM vigilante_rules WHERE status = 'activa'").all() as Array<{
      class_key: string;
    }>
  ).map((r) => r.class_key);
  const dismissed = (
    db.prepare('SELECT DISTINCT occ_key FROM vigilante_dismissals').all() as Array<{
      occ_key: string;
    }>
  ).map((r) => r.occ_key);
  return { activeClasses: new Set(active), dismissedOccurrences: new Set(dismissed) };
}

/** Regla activa para la clase del hallazgo (descubrimiento y recordatorios). */
export function ruleSuppresses(state: IgnoreState, item: AgendaItem): boolean {
  const key = classKey(item);
  return key !== null && state.activeClasses.has(key);
}

export function formatRules(rules: ReturnType<typeof listRules>): string {
  if (rules.length === 0) {
    return 'No hay reglas de ignorar. Cuando descartes dos avisos parecidos con /ignora <número>, te propongo una.';
  }
  const lines = rules.map(
    (r) =>
      `• R${r.id} [${r.status}] ${r.kind} · ${r.src} · «${r.pattern}» (descartados: ${r.dismissed})`,
  );
  return `Reglas de ignorar:\n${lines.join('\n')}\nActivar una propuesta: /ignorados activar <id>. Borrar: /ignorados borrar <id>.`;
}
