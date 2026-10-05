import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Copia de seguridad nocturna del estado de Asistenta (bases de datos y memoria).
 *
 * Todo vive en un solo directorio y se pierde junto: un disco roto o un borrado por
 * error se llevan la memoria entera. Una copia diaria local, con las últimas 7, cuesta
 * unos KB y permite volver atrás. No copia el navegador, los modelos ni las capturas
 * (pesan y se regeneran) ni el vault: un duplicado del vault con la misma máquina no
 * protege nada y sí multiplica donde viven los secretos.
 */

const KEEP_DEFAULT = 7;
const DAY_MS = 24 * 3_600_000;

/** Cada día a partir de las 03:00 locales, una vez cada 20 h. */
export function isBackupDue(now: Date, lastRunMs: number): boolean {
  return now.getHours() >= 3 && now.getTime() - lastRunMs > DAY_MS - 4 * 3_600_000;
}

function dayStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `VACUUM INTO` da una copia coherente aunque la base esté abierta y en modo WAL. */
function copyDb(src: string, dest: string): void {
  const db = new DatabaseSync(src);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

export interface BackupResult {
  dir: string;
  databases: string[];
  copiedDirs: string[];
  pruned: string[];
}

export function runBackup(opts: { stateDir: string; now?: Date; keep?: number }): BackupResult {
  const now = opts.now ?? new Date();
  const keep = Math.max(1, opts.keep ?? KEEP_DEFAULT);
  const root = join(opts.stateDir, 'backups');
  const dir = join(root, dayStamp(now));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const databases: string[] = [];
  for (const name of readdirSync(opts.stateDir)) {
    if (!name.endsWith('.db')) continue;
    copyDb(join(opts.stateDir, name), join(dir, name));
    databases.push(name);
  }
  const copiedDirs: string[] = [];
  for (const name of ['memory', 'snapshot', 'skills']) {
    const from = join(opts.stateDir, name);
    if (!existsSync(from)) continue;
    cpSync(from, join(dir, name), { recursive: true });
    copiedDirs.push(name);
  }

  const old = readdirSync(root)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort();
  const pruned = old.slice(0, Math.max(0, old.length - keep));
  for (const n of pruned) rmSync(join(root, n), { recursive: true, force: true });
  return { dir, databases, copiedDirs, pruned };
}
