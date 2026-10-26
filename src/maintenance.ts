/**
 * Mantenimiento y retención del estado local.
 *
 * Tres operaciones independientes, deliberadamente sin un planificador propio:
 * quien las llama decide cuándo. La regla común es no inventar datos ni borrar
 * de más: solo se toca lo que el filtro nombra, y un fallo de una parte no debe
 * impedir limpiar las demás.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { memoryFile } from './memory.js';

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

/**
 * Borra del mirror de documentos los `*.txt` cuya fecha de modificación es más
 * antigua que `now - olderThanMs`. Es plano y no recursivo a propósito: el
 * mirror real guarda un fichero por documento en la raíz.
 *
 * El índice SQLite (`docs.sqlite`) NO se toca aquí. Si existe, hay que limpiar
 * aparte sus filas para que no queden documentos indexados cuyo texto ya no
 * está en el mirror; este módulo no conoce el esquema de esa base.
 *
 * Devuelve cuántos ficheros se borraron. Un directorio ausente es cero, no un
 * error: el mirror puede no haberse creado todavía.
 */
export function pruneDocuments(dir: string, olderThanMs: number, now = Date.now()): number {
  const cutoff = now - Math.max(0, olderThanMs);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.txt')) continue;
    const file = join(dir, name);
    try {
      const info = statSync(file);
      if (!info.isFile() || info.mtimeMs >= cutoff) continue;
      rmSync(file, { force: true });
      removed++;
    } catch {
      // Un fichero que desaparece entre readdir y stat, o que no se puede
      // borrar, no debe impedir limpiar el resto del mirror.
    }
  }
  return removed;
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
