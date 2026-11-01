/**
 * Progreso por documento para PDFs largos: si Asistenta se corta (reinicio, tiempo
 * máximo, apagón), al volver a mandar el mismo PDF sigue por la primera página sin
 * hacer en vez de empezar de cero. Idea de pdf2md (https://github.com/Ntizar/pdf2md,
 * licencia MIT).
 *
 * Un fichero pequeño por documento (`<huella>.jsonl`, una línea por página hecha) en la
 * carpeta que se indique. Se borra al terminar bien; lo que quede a medias se borra solo
 * a los 7 días. Una última línea rota (corte a mitad de escribir) se ignora.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { OcrResult } from '../screen/ocr.js';

export const PROGRESS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Tope por línea: una página con más texto no se guarda (se rehará si hace falta). */
const MAX_LINE_CHARS = 512 * 1024;

export interface PageProgress {
  /** Resultado guardado de la página (0-based), si ya se hizo. */
  get(index: number): OcrResult | undefined;
  /** Apunta una página hecha. Si no se puede escribir, sigue sin progreso. */
  put(index: number, result: OcrResult): Promise<void>;
  /** Todo bien: borra el progreso. */
  finish(): Promise<void>;
  /** Páginas que ya estaban hechas al abrir. */
  readonly resumed: number;
  /** Páginas hechas ahora mismo (las de antes y las nuevas). */
  count(): number;
}

export function docKey(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 24);
}

async function pruneOld(dir: string, now: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!/^[0-9a-f]{24}\.jsonl$/.test(n)) continue;
    try {
      const s = await stat(join(dir, n));
      if (now - s.mtimeMs > PROGRESS_MAX_AGE_MS) await rm(join(dir, n), { force: true });
    } catch {
      // otro proceso lo borró: da igual
    }
  }
}

function isResult(v: unknown): v is OcrResult {
  const r = v as OcrResult;
  return !!r && typeof r.text === 'string' && Array.isArray(r.lines);
}

export async function openProgress(
  dir: string,
  bytes: Uint8Array,
  now: () => number = Date.now,
): Promise<PageProgress> {
  const file = join(dir, `${docKey(bytes)}.jsonl`);
  const done = new Map<number, OcrResult>();
  let writable = true;
  try {
    await mkdir(dir, { recursive: true });
    await pruneOld(dir, now());
  } catch {
    writable = false;
  }
  try {
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line) as { p?: unknown; r?: unknown };
        if (typeof o.p === 'number' && Number.isInteger(o.p) && o.p >= 0 && isResult(o.r)) {
          done.set(o.p, o.r);
        }
      } catch {
        // línea rota por un corte: esa página se rehace
      }
    }
  } catch {
    // sin progreso previo
  }
  const resumed = done.size;
  return {
    resumed,
    count: () => done.size,
    get: (i) => done.get(i),
    async put(i, result) {
      done.set(i, result);
      if (!writable) return;
      const line = JSON.stringify({ p: i, r: result });
      if (line.length > MAX_LINE_CHARS) return;
      try {
        await appendFile(file, `${line}\n`, 'utf8');
      } catch {
        writable = false;
      }
    },
    async finish() {
      await rm(file, { force: true }).catch(() => undefined);
    },
  };
}
