import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '../child-env.js';
import { log } from '../log.js';
import { sliceSafe } from '../text.js';

/**
 * PDF -> EPUB with calibre's `ebook-convert`, the one converter that handles PDFs well
 * on both Windows and Linux. It is optional: when it is not installed the book is kept
 * as a PDF, and the caller says so (Kindle accepts PDF by email too).
 */
export function converterCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const list = [env.PA_EBOOK_CONVERT ?? '', 'ebook-convert'];
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA]) {
    if (base) list.push(join(base, 'Calibre2', 'ebook-convert.exe'));
  }
  return list.filter(Boolean);
}

/**
 * Borra la carpeta temporal sin tumbar la conversión. En Windows el antivirus o el propio
 * Calibre (aún cerrándose) tienen el fichero abierto un momento y rmSync lanza EBUSY/EPERM:
 * dentro del `finally` eso tiraba el AZW3 ya hecho y Nico veía «no pude convertirlo».
 * Se reintenta unas veces y, si sigue, se deja (la limpia el sistema) y se apunta.
 */
export function cleanTmp(dir: string, rm: typeof rmSync = rmSync): void {
  try {
    rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    log.warn('temp folder left behind', { dir, err: String(err) });
  }
}

export type Runner = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number; stderr: string }>;

/**
 * Lanza el conversor con un tope. Al pasarse mata el ÁRBOL entero: ebook-convert reparte la
 * conversión en procesos hijos (calibre-parallel) y, en Windows, matar solo
 * ebook-convert.exe (lo que hacía execFile con `timeout`) los dejaba vivos comiendo CPU.
 * Windows: taskkill /F /T /PID. Fuera: el hijo va en su propio grupo y se mata el grupo.
 * La salida normal se descarta (Calibre escribe mucho): solo se guarda el final de stderr.
 */
export function makeRunner(
  opts: {
    spawnImpl?: typeof nodeSpawn;
    platform?: NodeJS.Platform;
    kill?: (pid: number, signal: NodeJS.Signals) => boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Runner {
  const spawn = opts.spawnImpl ?? nodeSpawn;
  const platform = opts.platform ?? process.platform;
  const kill = opts.kill ?? ((pid: number, sig: NodeJS.Signals) => process.kill(pid, sig));
  return (cmd, args, timeoutMs) =>
    new Promise((resolve) => {
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const finish = (code: number, extra = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code,
          stderr: `${stderr.slice(-400)}${extra}${timedOut ? '\nETIMEDOUT' : ''}`,
        });
      };
      let child: ReturnType<typeof nodeSpawn>;
      try {
        child = spawn(cmd, args, {
          windowsHide: true,
          env: childEnv(),
          stdio: ['ignore', 'ignore', 'pipe'],
          // Fuera de Windows, su propio grupo: así se mata con todos sus hijos.
          detached: platform !== 'win32',
        });
      } catch (err) {
        resolve({ code: 1, stderr: String(err instanceof Error ? err.message : err) });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        const pid = child.pid;
        try {
          if (platform === 'win32' && pid) {
            const root = (opts.env ?? process.env).SystemRoot ?? 'C:\\Windows';
            spawn(join(root, 'System32', 'taskkill.exe'), ['/F', '/T', '/PID', String(pid)], {
              windowsHide: true,
              stdio: 'ignore',
              env: childEnv(),
            }).on?.('error', () => child.kill?.('SIGKILL'));
          } else if (pid) kill(-pid, 'SIGKILL');
          else child.kill?.('SIGKILL');
        } catch {
          try {
            child.kill?.('SIGKILL');
          } catch {}
        }
        // Si el árbol no dice nada en 3 s, se responde igual (no se cuelga el Kindle).
        setTimeout(() => finish(1), 3_000).unref?.();
      }, timeoutMs);
      timer.unref?.();
      child.stderr?.on('data', (d: Buffer | string) => {
        stderr = `${stderr}${String(d)}`.slice(-4000);
      });
      child.on('error', (err: Error) => finish(1, err.message));
      child.on('close', (code: number | null) => finish(timedOut ? 1 : (code ?? 1)));
    });
}

const defaultRunner: Runner = makeRunner();

/**
 * El conversor encontrado, por runner y por lista de candidatos. Antes cada conversión
 * volvía a lanzar `ebook-convert --version` (en Windows, arrancar el Python de Calibre:
 * segundos por candidato y por «📖 Al Kindle»). Lo encontrado vale mientras siga en su
 * sitio; «no hay Calibre» se vuelve a mirar pasado CONVERTER_MISS_TTL_MS (por si lo instala).
 */
const converterCache = new WeakMap<Runner, Map<string, { cmd: string | null; at: number }>>();
export const CONVERTER_MISS_TTL_MS = 10 * 60_000;

export function _resetConverterCacheForTests(): void {
  converterCache.delete(defaultRunner);
}

function isPath(cmd: string): boolean {
  return cmd.includes('/') || cmd.includes('\\');
}

/** First converter that answers `--version`, or null (cached; see converterCache). */
export async function findConverter(
  run: Runner = defaultRunner,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): Promise<string | null> {
  const candidates = converterCandidates(env);
  const key = candidates.join('\n');
  let cache = converterCache.get(run);
  if (!cache) {
    cache = new Map();
    converterCache.set(run, cache);
  }
  const hit = cache.get(key);
  if (hit) {
    if (hit.cmd && (!isPath(hit.cmd) || existsSync(hit.cmd))) return hit.cmd;
    if (!hit.cmd && now() - hit.at < CONVERTER_MISS_TTL_MS) return null;
  }
  let found: string | null = null;
  for (const cmd of candidates) {
    // An absolute path that does not exist is skipped without spawning anything.
    if (isPath(cmd) && !existsSync(cmd)) continue;
    const r = await run(cmd, ['--version'], 10_000);
    if (r.code === 0) {
      found = cmd;
      break;
    }
  }
  cache.set(key, { cmd: found, at: now() });
  return found;
}

export type ConvertResult =
  | { ok: true; epub: Buffer }
  | { ok: false; reason: 'no-converter' | 'failed'; message: string };

export async function pdfToEpub(
  pdf: Buffer,
  title: string,
  run: Runner = defaultRunner,
  converter?: string | null,
): Promise<ConvertResult> {
  const cmd = converter === undefined ? await findConverter(run) : converter;
  if (!cmd) {
    return {
      ok: false,
      reason: 'no-converter',
      message: 'no hay conversor instalado (calibre: ebook-convert), así que dejo el PDF tal cual',
    };
  }
  const dir = mkdtempSync(join(tmpdir(), 'pa-book-'));
  try {
    const input = join(dir, 'libro.pdf');
    const output = join(dir, 'libro.epub');
    writeFileSync(input, pdf);
    const r = await run(cmd, [input, output, '--title', sliceSafe(title, 200)], 5 * 60_000);
    if (r.code !== 0 || !existsSync(output)) {
      return {
        ok: false,
        reason: 'failed',
        message: conversionFailText(r.stderr.trim() || `código ${r.code}`),
      };
    }
    return { ok: true, epub: readFileSync(output) };
  } finally {
    cleanTmp(dir);
  }
}

export type Azw3Result =
  | { ok: true; azw3: Buffer }
  | { ok: false; reason: 'no-converter' | 'failed'; message: string };

/**
 * EPUB -> AZW3 for a Kindle Paperwhite (11th gen and the like) over USB, with calibre's
 * `--output-profile kindle_pw3`. Optional like pdfToEpub: without calibre the EPUB stays
 * (Send to Kindle by email converts EPUB itself).
 */
export async function epubToAzw3(
  epub: Buffer,
  title: string,
  run: Runner = defaultRunner,
  converter?: string | null,
): Promise<Azw3Result> {
  const cmd = converter === undefined ? await findConverter(run) : converter;
  if (!cmd)
    return {
      ok: false,
      reason: 'no-converter',
      message: 'no hay Calibre (ebook-convert) en el PC',
    };
  const dir = mkdtempSync(join(tmpdir(), 'pa-kindle-'));
  try {
    const input = join(dir, 'libro.epub');
    const output = join(dir, 'libro.azw3');
    writeFileSync(input, epub);
    const r = await run(
      cmd,
      [input, output, '--output-profile', 'kindle_pw3', '--title', sliceSafe(title, 200)],
      5 * 60_000,
    );
    if (r.code !== 0 || !existsSync(output)) {
      log.warn('azw3 conversion failed', { detail: r.stderr.slice(-400) });
      return {
        ok: false,
        reason: 'failed',
        message: /ETIMEDOUT|timed? ?out/i.test(r.stderr)
          ? 'Calibre tardó más de 5 minutos y lo he parado'
          : 'Calibre no pudo convertirlo (el detalle queda en el registro del PC)',
      };
    }
    return { ok: true, azw3: readFileSync(output) };
  } finally {
    cleanTmp(dir);
  }
}

/**
 * Calibre's own words (a Python traceback, a Windows path) go to the log; the
 * chat gets one plain reason, and the book still goes out as PDF.
 */
export function conversionFailText(raw: string): string {
  log.warn('book conversion failed', { detail: raw.slice(-400) });
  const tail = 'así que lo dejo en PDF';
  if (/DRM/.test(raw)) return `el PDF tiene protección (DRM) y no se puede convertir, ${tail}`;
  if (/ETIMEDOUT|timed? ?out/i.test(raw))
    return `la conversión tardó más de 5 minutos y la he parado, ${tail}`;
  if (/MemoryError|out of memory|bad_alloc|ENOMEM/i.test(raw))
    return `el PC se quedó sin memoria al convertirlo, ${tail}`;
  if (/PdfReadError|not a PDF|invalid pdf|EOF marker|damaged|corrupt/i.test(raw))
    return `el PDF parece dañado y no se pudo convertir, ${tail}`;
  return `la conversión a EPUB falló (el detalle queda en el registro del PC), ${tail}`;
}
