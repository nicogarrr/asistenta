/**
 * «Resúmeme este vídeo»: el texto de un vídeo de YouTube a partir de sus subtítulos.
 *
 * Sin descargar el vídeo ni gastar en transcribir: yt-dlp baja solo los subtítulos
 * (los del autor o los automáticos de YouTube), en español si los hay y si no en
 * inglés, y aquí se quedan en texto plano. Lo usa la herramienta `fetch` cuando el
 * enlace es un vídeo de YouTube; si no hay subtítulos, `fetch` lee la página como
 * siempre. Mismos límites que `fetch`: solo enlaces públicos y, si está puesta,
 * la lista PA_FETCH_ALLOWED_HOSTS.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '../child-env.js';
import { normalizeHostname } from '../text.js';

export type RunResult = { stdout: string; stderr: string; code: number | 'ENOENT' };
export type Runner = (file: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export type TranscriptResult =
  | { ok: true; title: string; lang: string; text: string }
  | { ok: false; reason: string };

const TIMEOUT_MS = 60_000;

/** Un enlace a UN vídeo de YouTube (watch, shorts, live, youtu.be), no a un canal o lista. */
export function isYoutubeVideoUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = normalizeHostname(url.hostname).replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') return /^\/[\w-]{6,}/.test(url.pathname);
  if (host !== 'youtube.com') return false;
  if (url.pathname === '/watch') return /^[\w-]{6,}$/.test(url.searchParams.get('v') ?? '');
  return /^\/(shorts|live|embed)\/[\w-]{6,}/.test(url.pathname);
}

/** WebVTT → texto: fuera cabecera, tiempos y etiquetas; sin las líneas repetidas de los automáticos. */
export function vttToText(vtt: string): string {
  const out: string[] = [];
  for (const raw of vtt.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === 'WEBVTT' || line.includes('-->')) continue;
    if (/^(Kind|Language|NOTE|STYLE|REGION)\b/.test(line) || /^\d+$/.test(line)) continue;
    const text = line
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text || out.includes(text, Math.max(0, out.length - 3))) continue;
    out.push(text);
  }
  return out.join('\n');
}

/** es antes que en; dentro de cada idioma, los del autor antes que los automáticos (.orig/-orig fuera). */
function pickSubtitle(files: string[]): { file: string; lang: string } | null {
  const vtts = files.filter((f) => f.endsWith('.vtt'));
  for (const lang of ['es', 'en']) {
    const match = vtts.find((f) => new RegExp(`\\.${lang}(-[A-Za-z]+)?\\.vtt$`).test(f));
    if (match) return { file: match, lang };
  }
  const any = vtts[0];
  return any ? { file: any, lang: any.split('.').slice(-2, -1)[0] ?? '?' } : null;
}

function run(file: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, env: childEnv() },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, code: 0 });
        const e = err as NodeJS.ErrnoException & { code?: string | number };
        if (e.code === 'ENOENT') return resolve({ stdout, stderr, code: 'ENOENT' });
        resolve({ stdout, stderr, code: typeof e.code === 'number' ? e.code : 1 });
      },
    );
  });
}

export async function fetchYoutubeTranscript(
  url: string,
  opts: { ytdlp?: string; runImpl?: Runner } = {},
): Promise<TranscriptResult> {
  if (!isYoutubeVideoUrl(url)) return { ok: false, reason: 'no es un vídeo de YouTube' };
  const ytdlp = opts.ytdlp ?? (process.env.ASISTENTA_YTDLP || 'yt-dlp');
  const dir = await mkdtemp(join(tmpdir(), 'asistenta-subs-'));
  try {
    const res = await (opts.runImpl ?? run)(
      ytdlp,
      [
        '--skip-download',
        '--no-simulate',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        'es,es-.*,en,en-.*',
        '--sub-format',
        'vtt',
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
        '--socket-timeout',
        '30',
        '-o',
        join(dir, 'subs.%(ext)s'),
        '--print',
        'title',
        '--',
        url,
      ],
      TIMEOUT_MS,
    );
    if (res.code === 'ENOENT') return { ok: false, reason: 'no tengo yt-dlp instalado' };
    if (res.code !== 0) return { ok: false, reason: 'yt-dlp no pudo leer el vídeo' };
    const picked = pickSubtitle(await readdir(dir));
    if (!picked) return { ok: false, reason: 'el vídeo no tiene subtítulos' };
    const text = vttToText(await readFile(join(dir, picked.file), 'utf8'));
    if (!text) return { ok: false, reason: 'los subtítulos están vacíos' };
    const title =
      res.stdout
        .split(/\r?\n/)
        .find((l) => l.trim())
        ?.trim() || 'vídeo';
    return { ok: true, title, lang: picked.lang, text };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
