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
