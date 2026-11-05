import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Carga perezosa de node:sqlite. Un import estatico hace que Node 24 imprima
 * «ExperimentalWarning: SQLite is an experimental feature» en stderr en cada
 * proceso que importe el modulo, aunque nunca abra una base (cualquier
 * `pa vault …` o `pa --help` lo hacia), y rompe la salida exacta del CLI.
 * Aqui solo se carga cuando alguien abre una base de verdad.
 */
let impl: typeof DatabaseSync | undefined;

export function loadDatabaseSync(): typeof DatabaseSync {
  if (!impl) {
    impl = (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
      .DatabaseSync;
  }
  return impl;
}

/** Cuánto espera una escritura si otro proceso tiene la base cogida (como db.ts y memory.db). */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * Abre una base SQLite que pueden tocar a la vez el daemon, `pa …` y el MCP.
 * Sin `busy_timeout`, una escritura que coincidía con otra (una copia de
 * seguridad, `pa mcp`, un segundo proceso) fallaba al instante con «database is
 * locked» y se perdía (un objetivo, un permiso «Siempre»). Con él espera hasta
 * 5 s. `wal` deja leer mientras otro escribe, como ya hacían memory.db y la de
 * rutinas.
 */
export function openSqlite(file: string, opts: { wal?: boolean } = {}): DatabaseSync {
  const Db = loadDatabaseSync();
  const db = new Db(file);
  // Primero la espera: pasar a WAL también necesita el candado.
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  if (opts.wal) db.exec('PRAGMA journal_mode = WAL');
  return db;
}
