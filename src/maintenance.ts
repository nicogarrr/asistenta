/**
 * Mantenimiento y retención del estado local.
 *
 * Tres operaciones independientes, deliberadamente sin un planificador propio:
 * quien las llama decide cuándo. La regla común es no inventar datos ni borrar
 * de más: solo se toca lo que el filtro nombra, y un fallo de una parte no debe
 * impedir limpiar las demás.
 */
import { type Dirent, existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { memoryFile } from './memory.js';
import { prunable } from './state-files.js';

/** Un nombre de perfil seguro: sin separadores, sin `..` y sin nombres de dispositivo. */
const SAFE_OWNER = /^[A-Za-z0-9._-]+$/;

/**
 * Borra las sesiones TERMINADAS que empezaron antes de `now - olderThanMs` y
 * todos sus turnos. Una sesión abierta (`ended_at IS NULL`) no se toca nunca,
 * aunque sea antigua: puede ser una conversación larga en curso.
 *
 * El ancla es `started_at`, no el último turno, porque la retención se define
 * por la fecha de la conversación. Los índices FTS se mantienen solos: los
 * triggers de `SessionStore` borran también la fila del índice al borrar la
 * sesión o el turno.
 *
 * Devuelve el número de sesiones borradas (no de turnos).
 */
export function pruneSessions(db: DatabaseSync, olderThanMs: number, now = Date.now()): number {
  const cutoff = now - Math.max(0, olderThanMs);
  db.exec('BEGIN');
  try {
    db.prepare(
      `DELETE FROM session_turns
        WHERE session_id IN (
          SELECT id FROM sessions WHERE ended_at IS NOT NULL AND started_at < ?
        )`,
    ).run(cutoff);
    const result = db
      .prepare('DELETE FROM sessions WHERE ended_at IS NOT NULL AND started_at < ?')
      .run(cutoff);
    db.exec('COMMIT');
    return Number(result.changes);
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Si la transacción ya no existe, el error original es el que importa.
    }
    throw err;
  }
}

/** Días que se guardan las conversaciones terminadas si no se configura otra cosa. */
export const DEFAULT_SESSION_RETENTION_DAYS = 365;
const DAY_MS = 24 * 3_600_000;
/** Hora local a partir de la que corre la retención: después de la copia de las 03:00. */
const RETENTION_HOUR = 4;

/**
 * Días de retención de sesiones según `PA_SESSION_RETENTION_DAYS`. `0` la apaga;
 * un valor vacío, negativo o no numérico usa el valor por defecto (365).
 */
export function sessionRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PA_SESSION_RETENTION_DAYS?.trim();
  if (!raw) return DEFAULT_SESSION_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SESSION_RETENTION_DAYS;
  return Math.floor(n);
}

/**
 * Días de retención de documentos (`PA_DOCUMENT_RETENTION_DAYS`). Apagada por
 * defecto (0): un documento que Nico subió hace meses puede seguir siendo útil.
 */
export function documentRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PA_DOCUMENT_RETENTION_DAYS?.trim() || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Días de retención de ficheros sueltos que crecen sin límite (`PA_FILE_RETENTION_DAYS`):
 * log/ diarios, screenshots/, capturas temporales de voice/ y media/received. Apagada
 * por defecto (0); qué se poda lo dice el registro (src/state-files.ts, campo `prune`).
 */
export function fileRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PA_FILE_RETENTION_DAYS?.trim() || 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Borra los ficheros más antiguos que el plazo en los directorios que el registro
 * marca como podables. Nunca borra directorios ni sigue enlaces; un fallo en un
 * fichero no para la pasada. Devuelve cuántos ficheros borró.
 */
export function pruneStateFiles(stateDir: string, olderThanMs: number, now = Date.now()): number {
  const cutoff = now - olderThanMs;
  let removed = 0;
  const walk = (dir: string, match?: RegExp): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, match);
        continue;
      }
      if (!e.isFile() || (match && !match.test(e.name))) continue;
      try {
        if (lstatSync(p).mtimeMs < cutoff) {
          rmSync(p, { force: true });
          removed++;
        }
      } catch {
        // sigue con el resto
      }
    }
  };
  for (const p of prunable()) walk(join(stateDir, p.dir), p.match);
  return removed;
}

export interface RetentionDeps {
  db: DatabaseSync;
  /** Olvida documentos (índice + mirror) más antiguos que el plazo; ver DocMemory.pruneOlderThan. */
  pruneDocs?: (olderThanMs: number) => number;
  now: Date;
  /** Última pasada que terminó bien (ms), 0 si nunca. */
  lastRunMs: number;
  markRun: (atMs: number) => void;
  env?: NodeJS.ProcessEnv;
  /** Directorio de estado; sin él no se podan ficheros (PA_FILE_RETENTION_DAYS). */
  stateDir?: string;
}

/**
 * Pasada diaria de retención que llama el daemon en su tick de 10 min. Corre una vez
 * al día a partir de las 04:00 locales (la copia de seguridad de las 03:00 ya tiene lo
 * que se va a borrar). Solo marca la pasada como hecha si terminó bien.
 */
export function retentionIfDue(deps: RetentionDeps): {
  ran: boolean;
  sessions: number;
  documents: number;
  files: number;
} {
  const days = sessionRetentionDays(deps.env);
  const docDays = deps.pruneDocs ? documentRetentionDays(deps.env) : 0;
  const fileDays = deps.stateDir ? fileRetentionDays(deps.env) : 0;
  const idle = { ran: false, sessions: 0, documents: 0, files: 0 };
  if (days === 0 && docDays === 0 && fileDays === 0) return idle;
  const now = deps.now;
  if (now.getHours() < RETENTION_HOUR) return idle;
  if (now.getTime() - deps.lastRunMs < DAY_MS - 4 * 3_600_000) return idle;
  const sessions = days > 0 ? pruneSessions(deps.db, days * DAY_MS, now.getTime()) : 0;
  const documents = docDays > 0 && deps.pruneDocs ? deps.pruneDocs(docDays * DAY_MS) : 0;
  const files =
    fileDays > 0 && deps.stateDir
      ? pruneStateFiles(deps.stateDir, fileDays * DAY_MS, now.getTime())
      : 0;
  deps.markRun(now.getTime());
  return { ran: true, sessions, documents, files };
}

/** Borra un fichero solo si existe; nunca propaga el error. */
function removeFile(file: string): boolean {
  try {
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * El dueño del perfil se deduce del scope real (`canal:cuenta:chatId#hilo`):
 * el id del chat es el último componente antes del hilo. El modo local usa
 * `local.json` aunque el scope lleve canal y cuenta. Un scope simple
 * (`global`) se trata como su propio dueño por si el perfil se nombró así.
 */
function ownerFromScope(scope: string): string | null {
  try {
    const chatKey = scope.trim().split('#', 1)[0] ?? '';
    if (!chatKey) return null;
    const parts = chatKey.split(':').filter(Boolean);
    if (parts.length === 0) return null;
    const owner = parts[0] === 'local' ? 'local' : (parts.at(-1) ?? '');
    if (!owner || owner === '.' || owner === '..' || !SAFE_OWNER.test(owner)) return null;
    return owner;
  } catch {
    return null;
  }
}

/**
 * Borra todo lo que pertenece a un scope: su fichero de memoria, sus sesiones
 * (y turnos) y, si el scope es del propietario, su perfil. Nunca toca otros
 * scopes.
 *
 * - La memoria se localiza con `memoryFile`, el mismo nombre percent-encoded
 *   que usa `MemoryStore`: un scope como `../fuera` no puede escapar del
 *   directorio de memoria.
 * - Las sesiones se filtran por igualdad exacta de `scope`; los triggers FTS
 *   mantienen el índice.
 * - El perfil es único por propietario (`profile/<chatId>.json`), no por
 *   hilo, así que se borra cuando el scope cuelga de ese chat.
 *
 * Nunca lanza: devuelve qué se pudo borrar. Un `sessions` a 0 puede significar
 * "no había" o "la base no estaba disponible"; en ambos casos la memoria y el
 * perfil se intentan igualmente.
 */
export function eraseScope(opts: { stateDir: string; scope: string; db?: DatabaseSync }): {
  memoryFile: boolean;
  sessions: number;
  profile: boolean;
} {
  let memoryFileDeleted = false;
  try {
    memoryFileDeleted = removeFile(memoryFile(join(opts.stateDir, 'memory'), opts.scope));
  } catch {
    // Un scope no representable como nombre de fichero no debe romper el resto.
  }

  let sessions = 0;
  if (opts.db) {
    try {
      opts.db.exec('BEGIN');
      try {
        opts.db
          .prepare(
            `DELETE FROM session_turns
              WHERE session_id IN (SELECT id FROM sessions WHERE scope = ?)`,
          )
          .run(opts.scope);
        const result = opts.db.prepare('DELETE FROM sessions WHERE scope = ?').run(opts.scope);
        opts.db.exec('COMMIT');
        sessions = Number(result.changes);
      } catch {
        try {
          opts.db.exec('ROLLBACK');
        } catch {
          // La base puede estar cerrada o sin esquema; el contrato es no lanzar.
        }
      }
    } catch {
      // BEGIN falló (base cerrada, transacción ajena...): no hay sesiones que contar.
    }
  }

  let profile = false;
  try {
    const owner = ownerFromScope(opts.scope);
    if (owner) profile = removeFile(join(opts.stateDir, 'profile', `${owner}.json`));
  } catch {
    // Un `stateDir` inválido tampoco puede hacer saltar el borrado por scope.
  }

  return { memoryFile: memoryFileDeleted, sessions, profile };
}
