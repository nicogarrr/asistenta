import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '../child-env.js';
import { log } from '../log.js';

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

export type Runner = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ code: number; stderr: string }>;

const defaultRunner: Runner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true, env: childEnv() },
      (err, _out, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        // A 5-minute timeout kills the converter with nothing on stderr: say so.
        const why = err && (err as { killed?: boolean }).killed ? '\nETIMEDOUT' : '';
        resolve({ code, stderr: `${String(stderr ?? '').slice(-400)}${why}` });
      },
    );
  });

/** First converter that answers `--version`, or null. */
export async function findConverter(
  run: Runner = defaultRunner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  for (const cmd of converterCandidates(env)) {
    // An absolute path that does not exist is skipped without spawning anything.
    if ((cmd.includes('/') || cmd.includes('\\')) && !existsSync(cmd)) continue;
    const r = await run(cmd, ['--version'], 10_000);
    if (r.code === 0) return cmd;
  }
  return null;
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
    const r = await run(cmd, [input, output, '--title', title.slice(0, 200)], 5 * 60_000);
    if (r.code !== 0 || !existsSync(output)) {
      return {
        ok: false,
        reason: 'failed',
        message: conversionFailText(r.stderr.trim() || `código ${r.code}`),
      };
    }
    return { ok: true, epub: readFileSync(output) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
