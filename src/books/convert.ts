import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, _out, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stderr: String(stderr ?? '').slice(-400) });
    });
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
        message: `la conversión falló: ${r.stderr.trim() || `código ${r.code}`}`,
      };
    }
    return { ok: true, epub: readFileSync(output) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
