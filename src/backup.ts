import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { wallClock } from './datecontext.js';
import { backedUp } from './state-files.js';

/**
 * Copia de seguridad nocturna del estado de Asistenta (bases de datos y memoria).
 *
 * Todo vive en un solo directorio y se pierde junto: un borrado por error o una base
 * corrupta se llevan la memoria entera. Una copia diaria, con las últimas 7, cuesta unos
 * KB y permite volver atrás. Por defecto va al mismo disco (state/backups): eso NO protege
 * de un disco roto ni de perder el PC. Dos salidas para eso: `PA_BACKUP_DIR` cambia la
 * raíz de las copias a otro disco o carpeta sincronizada, y `PA_BACKUP_MIRROR` escribe
 * ADEMÁS una segunda copia completa (la local se cierra primero; si el espejo falla, el
 * error lo nombra y la copia local sigue buena). Para restaurar: parar Asistenta y copiar
 * los .db y carpetas de la fecha elegida encima del directorio de estado.
 * Copia los *.db y *.sqlite de la raíz (VACUUM INTO, coherente aunque estén abiertas),
 * los *.json de la raíz (alertas de precio, entrega de rutinas), docs/ (docs.sqlite más
 * el mirror de texto) y las carpetas y ficheros que marca el registro único de estado
 * (`state-files.ts`: memory/, calendar/, profile/, salidas/, audit/, actions.jsonl…).
 * No copia el navegador, los modelos ni las capturas (pesan y se regeneran) ni el vault:
 * un duplicado del vault con la misma máquina no protege nada y sí multiplica donde
 * viven los secretos.
 */

/** Ficheros sueltos de la raíz que no son *.json pero son estado (p. ej. actions.jsonl). */
const ROOT_FILES = new Set(backedUp('file'));

const KEEP_DEFAULT = 7;

/**
 * Falló solo el segundo destino (PA_BACKUP_MIRROR): la copia local YA está hecha.
 * Antes era un Error genérico y el daemon la tomaba por «copia no hecha»: repetía
 * la copia local entera cada 10 minutos mientras el disco del espejo siguiera
 * desconectado, y avisaba «No he podido hacer la copia de seguridad de hoy».
 */
export class BackupMirrorError extends Error {
  readonly code: string | undefined;
  readonly localDir: string;
  readonly mirrorRoot: string;
  constructor(localDir: string, mirrorRoot: string, cause: unknown) {
    super(
      `copia local hecha en ${localDir}, pero el segundo destino ${mirrorRoot} falló: ${String(cause)}`,
    );
    this.name = 'BackupMirrorError';
    this.localDir = localDir;
    this.mirrorRoot = mirrorRoot;
    const code = (cause as { code?: unknown } | null)?.code;
    this.code = typeof code === 'string' ? code : undefined;
  }
}

/** true si la copia local de hoy quedó hecha aunque algo fallara después (el espejo). */
export function localBackupDone(err: unknown): boolean {
  return err instanceof BackupMirrorError;
}

/** Aviso en castellano llano cuando solo falla el segundo destino. Nada de códigos. */
export function backupMirrorNotice(err: BackupMirrorError): string {
  const base = `He hecho la copia de seguridad de hoy en este PC, pero no he podido guardar la segunda copia en ${err.mirrorRoot}`;
  const c = err.code ?? '';
  if (c === 'ENOENT' || c === 'ENOTDIR' || c === 'ENODEV' || c === 'EIO')
    return `${base}: no encuentro esa carpeta. ¿Está conectado ese disco? Lo intento otra vez mañana.`;
  if (c === 'EACCES' || c === 'EPERM' || c === 'EROFS')
    return `${base}: no tengo permiso para escribir ahí. Lo intento otra vez mañana.`;
  if (c === 'ENOSPC')
    return `${base}: ese disco está lleno. Libera espacio; lo intento otra vez mañana.`;
  return `${base}. Lo intento otra vez mañana.`;
}
const DAY_MS = 24 * 3_600_000;

/** Cada día a partir de las 03:00 locales, una vez cada 20 h. */
export function isBackupDue(now: Date, lastRunMs: number): boolean {
  return wallClock(now).hour >= 3 && now.getTime() - lastRunMs > DAY_MS - 4 * 3_600_000;
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
  /** Segunda copia completa (`mirrorDir` de la llamada), si se pidió. */
  mirrorDir?: string;
  mirrorPruned?: string[];
}

export function runBackup(opts: {
  stateDir: string;
  /** Raíz de las copias. Por defecto `<stateDir>/backups`. */
  destDir?: string;
  /** Segundo destino ADEMÁS del primero (otro disco, carpeta sincronizada). */
  mirrorDir?: string;
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
      const from = join(opts.stateDir, name);
      if (!statSync(from).isFile()) continue;
      // Las bases *.sqlite también entran (no todas acaban en .db).
      if (name.endsWith('.db') || name.endsWith('.sqlite')) {
        copyDb(from, join(tmp, name));
        databases.push(name);
      } else if (name.endsWith('.json') || ROOT_FILES.has(name)) {
        // Configuración que solo existe aquí: routine-delivery.json, modelos.json...
        cpSync(from, join(tmp, name));
      }
    }
    // calendar/ (agenda local: lo que apuntas sin Google), profile/ (tu perfil) y
    // services/ no tienen otra copia y antes no entraban en la copia de seguridad.
    // Las carpetas salen del registro único (state-files.ts): calendar/, profile/,
    // salidas/, audit/… solo existen aquí.
    for (const name of backedUp('dir')) {
      const from = join(opts.stateDir, name);
      if (!existsSync(from)) continue;
      cpSync(from, join(tmp, name), { recursive: true });
      copiedDirs.push(name);
    }
    // docs/ lleva una base viva: docs.sqlite via VACUUM INTO (copia coherente
    // aunque esté abierta) y el mirror de texto como ficheros normales.
    const docs = join(opts.stateDir, 'docs');
    if (existsSync(docs)) {
      mkdirSync(join(tmp, 'docs'), { recursive: true });
      const docsDb = join(docs, 'docs.sqlite');
      if (existsSync(docsDb)) copyDb(docsDb, join(tmp, 'docs', 'docs.sqlite'));
      const mirror = join(docs, 'mirror');
      if (existsSync(mirror)) cpSync(mirror, join(tmp, 'docs', 'mirror'), { recursive: true });
      copiedDirs.push('docs');
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

  let mirrorDir: string | undefined;
  let mirrorPruned: string[] | undefined;
  if (opts.mirrorDir) {
    // La copia local YA está cerrada: un fallo del espejo no la toca, pero
    // tampoco se calla - el error nombra el segundo destino.
    const mroot = opts.mirrorDir;
    const mdir = join(mroot, dayStamp(now));
    const mtmp = `${mdir}.tmp`;
    try {
      mkdirSync(mroot, { recursive: true });
      rmSync(mtmp, { recursive: true, force: true });
      cpSync(dir, mtmp, { recursive: true });
      rmSync(mdir, { recursive: true, force: true });
      renameSync(mtmp, mdir);
    } catch (err) {
      try {
        rmSync(mtmp, { recursive: true, force: true });
      } catch {
        // La limpieza puede fallar por la misma causa que el espejo (p. ej.
        // ENOTDIR): nunca debe tapar el error que nombra el destino.
      }
      throw new BackupMirrorError(dir, mroot, err);
    }
    const mold = readdirSync(mroot)
      .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
      .sort();
    mirrorPruned = mold.slice(0, Math.max(0, mold.length - keep));
    for (const n of mirrorPruned) rmSync(join(mroot, n), { recursive: true, force: true });
    mirrorDir = mdir;
  }
  return { dir, databases, copiedDirs, pruned, mirrorDir, mirrorPruned };
}
