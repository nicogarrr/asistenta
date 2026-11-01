import { randomBytes } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineDeps } from './engine.js';
import { detectKind, type OcrMode, runOcrJob } from './job.js';

/**
 * Carpeta automática de OCR: dejas un PDF en la carpeta de entrada y aparece su
 * Markdown (y/o PDF con texto) en `salida/`. Apagada por defecto (opt-in con
 * PA_OCR_WATCH_DIR). Coste 0: usa el mismo motor local que `/ocr`.
 *
 * Reglas:
 * - Solo los archivos sueltos de la carpeta de entrada (sin recursión) y solo PDF reales
 *   (se mira la firma de los bytes, no la extensión).
 * - Un archivo se toca solo cuando lleva `settleMs` sin cambiar (no se lee a medias una
 *   descarga o copia en curso) y cuando tamaño+mtime son iguales en dos lecturas.
 * - Cada archivo se reclama con un rename atómico (dos watchers no pueden llevarse el
 *   mismo). Antes de leer, tras leer y tras el OCR se revalida tamaño+mtime+inodo; si
 *   cambió, no se archiva nada y el archivo vuelve a la entrada.
 * - Resultado OK: salida publicada con enlace exclusivo (nunca pisa, aunque otro proceso
 *   cree el destino a la vez) y DESPUÉS el original pasa a `originales/`. Nunca se borra
 *   contenido. Si el proceso muere a mitad, queda un `.claim-*` oculto en la carpeta con
 *   el original intacto (se puede renombrar a mano).
 * - Fallo: el original se mueve a `errores/` junto a un `.txt` con el motivo.
 * - De uno en uno; el contenido del documento no se escribe en los logs.
 */
export const OUT_DIR = 'salida';
export const DONE_DIR = 'originales';
export const ERR_DIR = 'errores';
const TEMP_SUFFIX = /\.(crdownload|part|tmp|download|partial)$/i;

export interface WatcherLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface WatcherOptions {
  dir: string;
  mode: OcrMode;
  makeDeps: (workDir: string) => EngineDeps;
  log: WatcherLog;
  settleMs?: number;
  now?: () => number;
  /** Tope de lectura: más grande que esto va a errores sin leerse entera. */
  maxBytes?: number;
  /** Carpeta del registro de páginas hechas: un PDF largo que se corta sigue por ahí. */
  progressDir?: string;
}

export interface ScanSummary {
  processed: string[];
  failed: string[];
  skipped: number;
}

function candidate(filename: string, i: number): string {
  if (i === 1) return filename;
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  return `${base}-${i}${ext}`;
}

/**
 * Publica `srcPath` en `dir/filename` SIN pisar nunca: `link` falla con EEXIST de forma
 * atómica si el destino existe (aunque lo haya creado otro proceso un instante antes) y
 * entonces se prueba el siguiente nombre. Devuelve el nombre final.
 */
async function linkNew(dir: string, filename: string, srcPath: string): Promise<string> {
  for (let i = 1; i < 1000; i++) {
    const name = candidate(filename, i);
    try {
      await link(srcPath, join(dir, name));
      return name;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error('no hay nombre libre');
}

async function writeNew(dir: string, filename: string, data: Buffer | string): Promise<string> {
  const tmp = join(dir, `.${randomBytes(6).toString('hex')}.tmp`);
  await writeFile(tmp, data, { flag: 'wx' });
  try {
    return await linkNew(dir, filename, tmp);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

/** Mueve sin pisar: enlace exclusivo y luego se quita el origen. */
async function moveNew(dir: string, srcPath: string, filename: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const name = await linkNew(dir, filename, srcPath);
  await unlink(srcPath);
  return name;
}

interface Sig {
  size: number;
  mtimeMs: number;
  ino: number;
}
const sigOf = (st: { size: number; mtimeMs: number; ino: number }): Sig => ({
  size: st.size,
  mtimeMs: st.mtimeMs,
  ino: st.ino,
});
const sameSig = (a: Sig, b: Sig): boolean =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

export class OcrFolderWatcher {
  private readonly lastSeen = new Map<string, string>();
  private busy = false;
  private readonly opts: WatcherOptions;
  constructor(opts: WatcherOptions) {
    this.opts = opts;
  }

  /** Un barrido. Seguro de llamar a mano; si ya hay uno en curso no hace nada. */
  async scanOnce(): Promise<ScanSummary> {
    const summary: ScanSummary = { processed: [], failed: [], skipped: 0 };
    if (this.busy) return summary;
    this.busy = true;
    try {
      const { dir } = this.opts;
      const now = (this.opts.now ?? Date.now)();
      const settleMs = this.opts.settleMs ?? 5_000;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
      if (!entries) return summary;
      for (const e of entries) {
        const name = e.name;
        if (!e.isFile() || name.startsWith('.') || name.startsWith('~$') || TEMP_SUFFIX.test(name))
          continue;
        if (!/\.pdf$/i.test(name)) continue;
        const st = await stat(join(dir, name)).catch(() => null);
        if (!st) continue;
        const cur = sigOf(st);
        const sig = `${cur.size}:${cur.mtimeMs}:${cur.ino}`;
        const prev = this.lastSeen.get(name);
        this.lastSeen.set(name, sig);
        if (prev !== sig || now - st.mtimeMs < settleMs) {
          summary.skipped++;
          continue;
        }
        const ok = await this.processOne(name, cur);
        this.lastSeen.delete(name);
        (ok ? summary.processed : summary.failed).push(name);
      }
      for (const k of [...this.lastSeen.keys()]) {
        if (!entries.some((x) => x.name === k)) this.lastSeen.delete(k);
      }
    } finally {
      this.busy = false;
    }
    return summary;
  }

  /** Archiva un fallo: el original reclamado va a errores/ con un .txt del motivo. */
  private async fail(name: string, claimed: string, reason: string): Promise<false> {
    const { dir, log } = this.opts;
    try {
      const moved = await moveNew(join(dir, ERR_DIR), join(dir, claimed), name);
      await writeNew(join(dir, ERR_DIR), `${moved}.txt`, `${reason}\n`);
    } catch (err) {
      log.warn('ocr-folder: no se pudo archivar el fallo', { err: String(err).slice(0, 200) });
    }
    log.warn('ocr-folder: archivo con error', { reason: reason.slice(0, 200) });
    return false;
  }

  /** Devuelve el archivo reclamado a la carpeta de entrada (sin pisar nada nuevo). */
  private async release(name: string, claimed: string): Promise<void> {
    const { dir, log } = this.opts;
    try {
      await linkNew(dir, name, join(dir, claimed));
      await unlink(join(dir, claimed));
    } catch (err) {
      log.warn('ocr-folder: no se pudo devolver el archivo', { err: String(err).slice(0, 200) });
    }
  }

  private async processOne(name: string, expected: Sig): Promise<boolean> {
    const { dir, mode, makeDeps, log } = this.opts;
    const maxBytes = this.opts.maxBytes ?? 200 * 1024 * 1024;
    // Reclamo atómico: rename es todo-o-nada, así que si otro watcher (u otro arranque)
    // compite, solo uno consigue el archivo; el otro recibe ENOENT y sigue. Mientras está
    // reclamado, un productor que escriba un archivo nuevo con el mismo nombre no se pisa.
    const claimed = `.claim-${randomBytes(6).toString('hex')}-${name}`;
    try {
      await rename(join(dir, name), join(dir, claimed));
    } catch {
      return false;
    }
    const cpath = join(dir, claimed);
    const unchanged = async (): Promise<boolean> => {
      const st = await stat(cpath).catch(() => null);
      return !!st && sameSig(sigOf(st), expected);
    };
    // Si no es el archivo que vimos estable (lo cambiaron entre el barrido y el reclamo).
    if (!(await unchanged())) {
      await this.release(name, claimed);
      return false;
    }
    if (expected.size > maxBytes)
      return this.fail(name, claimed, 'El archivo es demasiado grande.');
    let bytes: Buffer;
    try {
      bytes = await readFile(cpath);
    } catch {
      return this.fail(name, claimed, 'No se pudo leer el archivo.');
    }
    if (bytes.length !== expected.size || !(await unchanged())) {
      await this.release(name, claimed);
      return false;
    }
    if (detectKind(bytes) !== 'pdf') return this.fail(name, claimed, 'No es un PDF válido.');
    const result = await runOcrJob(
      bytes,
      { name, progressDir: this.opts.progressDir },
      mode,
      makeDeps,
    );
    // Revalidar tras el OCR: si el archivo cambió mientras se procesaba, la salida no
    // corresponde a lo que hay ahora; se descarta y el archivo vuelve a la entrada.
    if (!(await unchanged())) {
      await this.release(name, claimed);
      log.warn('ocr-folder: el archivo cambió durante el proceso; se reintentará');
      return false;
    }
    if (!result.ok) return this.fail(name, claimed, result.message);
    try {
      await mkdir(join(dir, OUT_DIR), { recursive: true });
      for (const f of result.files) {
        await writeNew(join(dir, OUT_DIR), f.filename, f.bytes);
      }
      await moveNew(join(dir, DONE_DIR), cpath, name);
    } catch (err) {
      log.warn('ocr-folder: fallo al escribir la salida', { err: String(err).slice(0, 200) });
      await this.release(name, claimed);
      return false;
    }
    log.info('ocr-folder: procesado', { files: result.files.length });
    return true;
  }

  start(intervalMs = 15_000): () => void {
    const timer = setInterval(() => {
      void this.scanOnce().catch((err) =>
        this.opts.log.warn('ocr-folder: barrido falló', { err: String(err).slice(0, 200) }),
      );
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }
}

export function watchModeFromEnv(v: string | undefined): OcrMode {
  const a = (v ?? '').trim().toLowerCase();
  if (a === 'pdf' || a === 'todo') return a;
  return 'md';
}
