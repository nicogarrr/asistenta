import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Copia de seguridad nocturna del estado de Asistenta (bases de datos y memoria).
 *
 * Todo vive en un solo directorio y se pierde junto: un borrado por error o una base
 * corrupta se llevan la memoria entera. Una copia diaria, con las últimas 7, cuesta unos
 * KB y permite volver atrás. Por defecto va al mismo disco (state/backups): eso NO protege
 * de un disco roto ni de perder el PC; para eso `PA_BACKUP_DIR` apunta a otro disco o a
 * una carpeta sincronizada. Para restaurar: parar Asistenta y copiar los .db y carpetas
 * de la fecha elegida encima del directorio de estado. No copia el navegador, los modelos ni las capturas
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

export function runBackup(opts: {
  stateDir: string;
  /** Raíz de las copias. Por defecto `<stateDir>/backups`. */
  destDir?: string;
  now?: Date;
  keep?: number;
}): BackupResult {
  const now = opts.now ?? new Date();
  const keep = Math.max(1, opts.keep ?? KEEP_DEFAULT);
  const root = opts.destDir ?? join(opts.stateDir, 'backups');
  const dir = join(root, dayStamp(now));
  // Se copia a una carpeta temporal y solo al terminar sustituye a la del día: un fallo
  // a medias no pierde la copia buena anterior ni deja una parcial contando como copia.
  const tmp = `${dir}.tmp`;
  mkdirSync(root, { recursive: true });
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });

  const databases: string[] = [];
  const copiedDirs: string[] = [];
  try {
    for (const name of readdirSync(opts.stateDir)) {
      if (!name.endsWith('.db')) continue;
      copyDb(join(opts.stateDir, name), join(tmp, name));
      databases.push(name);
    }
    for (const name of ['memory', 'snapshot', 'skills']) {
      const from = join(opts.stateDir, name);
      if (!existsSync(from)) continue;
      cpSync(from, join(tmp, name), { recursive: true });
      copiedDirs.push(name);
    }
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }

  const old = readdirSync(root)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort();
  const pruned = old.slice(0, Math.max(0, old.length - keep));
  for (const n of pruned) rmSync(join(root, n), { recursive: true, force: true });
  return { dir, databases, copiedDirs, pruned };
}
