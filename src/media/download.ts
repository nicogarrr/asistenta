import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { log } from '../log.js';
import { isFetchable } from '../tools/fetch.js';
import { COOKIE_BROWSERS } from './cookie-browsers.js';

/**
 * Download a video or a PDF from a link the user pasted, so it can be sent back to the chat.
 *
 * Videos go through yt-dlp (YouTube, X, TikTok, Instagram, Vimeo and ~1000 more sites,
 * free and open source). PDFs are fetched directly. Both are capped at what a Telegram bot
 * may upload (50 MB); when something does not fit or fails, the caller gets a plain
 * Spanish reason instead of a silent nothing.
 */

/** Telegram's Bot API upload cap is 50 MB; stay a little under it. */
export const MAX_UPLOAD_BYTES = 49 * 1024 * 1024;
const VIDEO_TIMEOUT_MS = 240_000;
const PDF_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

export type DownloadResult =
  | { ok: true; kind: 'video'; bytes: Buffer; title: string; seconds: number; filename: string }
  | { ok: true; kind: 'pdf'; bytes: Buffer; title: string; seconds: 0; filename: string }
  | { ok: false; reason: string };

/** Optional anti-bot helpers. Everything here is off or auto-detected; see config.ts. */
export interface DownloadOptions {
  /** Path to yt-dlp; defaults to ASISTENTA_YTDLP or `yt-dlp` on PATH. */
  ytdlp?: string;
  /** Browser to read cookies from for yt-dlp (firefox, chrome, edge...). Empty = off. */
  cookiesFromBrowser?: string;
}

// TODO(seguridad): isFetchable es un filtro léxico y yt-dlp sigue sus propias redirecciones
// sin revalidar; un host público que resuelva a una IP interna pasaría. Mismo nivel que la
// tool fetch. Endurecer resolviendo DNS y validando la IP.
export function parsePublicUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return isFetchable(url.toString()) ? url : null;
}

/** Quality ladder: 720p first, then smaller if the file would not fit in Telegram. */
const HEIGHTS = [720, 480, 360];

function formatFor(height: number): string {
  return [
    `bv*[height<=${height}][ext=mp4][vcodec^=avc1]+ba[ext=m4a]`,
    `b[height<=${height}][ext=mp4]`,
    `bv*[height<=${height}]+ba`,
    `b[height<=${height}]`,
    `w`,
  ].join('/');
}

function run(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | 'ENOENT' }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout, stderr, code: 0 });
        const e = err as NodeJS.ErrnoException & { code?: string | number };
        if (e.code === 'ENOENT') return resolve({ stdout, stderr, code: 'ENOENT' });
        resolve({
          stdout,
          stderr: stderr || String(err.message),
          code: typeof e.code === 'number' ? e.code : 1,
        });
      },
    );
  });
}

export interface ExplainContext {
  /** Cookies from a browser were passed to yt-dlp. */
  cookies?: string;
  /** The link is a YouTube link. */
  youtube?: boolean;
  /** deno is installed (yt-dlp needs a JavaScript runtime for YouTube; only deno is on by default). */
  deno?: boolean;
}

const DENO_STEP = 'instala deno (en Windows: winget install DenoLand.Deno) y reinicia el bot';
const COOKIES_STEP =
  'activa las cookies de un navegador donde tengas sesión iniciada (PA_DOWNLOAD_COOKIES_BROWSER=firefox)';

/** Turns yt-dlp's English stderr into something honest and short, in Spanish. */
export function explainYtdlpError(stderr: string, ctx: ExplainContext = {}): string {
  const s = stderr.toLowerCase();
  if (/unsupported url/.test(s)) return 'ese enlace no tiene ningún vídeo que yo pueda descargar';
  // Reading the browser's cookie store failed: not the video's fault.
  if (/could not (copy|find)[^\n]*cookie|failed to decrypt|cookie database|dpapi/.test(s)) {
    return `no pude leer las cookies de ${ctx.cookies ?? 'tu navegador'} (Chrome y Edge suelen bloquearlas mientras están abiertos; cierra el navegador o prueba con Firefox)`;
  }
  // YouTube's "confirm you're not a bot" is not a private video: it asks for a JS runtime
  // and/or a logged-in session, and saying "private" would send the user the wrong way.
  if (/confirm you.?re not a bot|not a bot/.test(s)) {
    if (ctx.cookies) {
      return `YouTube sigue pidiéndome que confirme que no soy un robot aunque uso las cookies de ${ctx.cookies}; abre YouTube en ese navegador con tu sesión iniciada y reinténtalo, o espera un rato`;
    }
    if (ctx.deno === false) {
      return `YouTube me pide confirmar que no soy un robot y en este equipo falta deno: ${DENO_STEP} y reintenta; si sigue igual, ${COOKIES_STEP}`;
    }
    return `YouTube me pide confirmar que no soy un robot; ${COOKIES_STEP}, o espera un rato`;
  }
  if (
    /javascript runtime|js runtime|challenge solving failed|signature solving failed|n challenge/.test(
      s,
    )
  ) {
    return `a yt-dlp le falta un entorno JavaScript para YouTube: ${DENO_STEP}`;
  }
  if (/private|login|sign in|log in|authentication|cookies/.test(s))
    return 'el vídeo es privado o exige iniciar sesión, y no puedo descargarlo sin tu cuenta';
  if (/age[- ]restricted|confirm your age/.test(s)) return 'el vídeo tiene restricción de edad';
  if (
    /video unavailable|this video is not available|has been removed|was deleted|does not exist|http error 404/.test(
      s,
    )
  )
    return 'el vídeo ya no está disponible';
  if (/requested format is not available/.test(s)) {
    return ctx.youtube && ctx.deno === false
      ? `YouTube no me da ningún formato descargable; casi seguro falta deno: ${DENO_STEP}`
      : 'ese vídeo no ofrece un formato que yo pueda descargar (si el sitio es YouTube, comprueba deno y actualiza yt-dlp)';
  }
  if (/geo|country|your location/.test(s)) return 'el vídeo está bloqueado en tu país';
  if (/drm/.test(s)) return 'el vídeo tiene protección DRM';
  if (/http error 429|too many requests|rate[- ]limit/.test(s))
    return 'el sitio me ha limitado por demasiadas peticiones; prueba en unos minutos';
  if (/timed out|timeout/.test(s)) return 'el sitio tardó demasiado en responder';
  if (/no video|no media|there is no video/.test(s)) return 'en ese enlace no hay vídeo';
  if (ctx.youtube && ctx.deno === false) {
    return `yt-dlp no pudo descargarlo y en este equipo falta deno, que YouTube necesita: ${DENO_STEP}`;
  }
  return 'yt-dlp no pudo descargarlo (el sitio puede haber cambiado; actualizar yt-dlp suele arreglarlo)';
}

/**
 * Picks yt-dlp's `--impersonate` target from `--list-impersonate-targets` output.
 *
 * Rows look like `Chrome-136  Macos-15  curl_cffi` (no bare `Chrome` row; `chrome` is an alias yt-dlp resolves); a target whose Python backend is missing is
 * marked `(unavailable)`. Returns 'chrome' only when a Chrome target can really be used,
 * because asking for one that is not there makes yt-dlp fail outright.
 */
export function parseImpersonateTargets(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (/^chrome(-|$)/i.test(cols[0] ?? '') && !/unavailable/i.test(line)) return 'chrome';
  }
  return null;
}

const impersonateCache = new Map<string, string | null>();

async function impersonateTarget(ytdlp: string): Promise<string | null> {
  if (impersonateCache.has(ytdlp)) return impersonateCache.get(ytdlp) ?? null;
  const res = await run(ytdlp, ['--list-impersonate-targets'], 30_000);
  // Only a real answer is cached: yt-dlp missing or a one-off failure may be fixed later.
  if (res.code !== 0) return null;
  const target = parseImpersonateTargets(res.stdout);
  impersonateCache.set(ytdlp, target);
  return target;
}

/** Test hook: forget what was detected. */
export function resetDownloadCachesForTests(): void {
  impersonateCache.clear();
  denoCache = null;
}

let denoCache: boolean | null = null;
async function hasDeno(): Promise<boolean> {
  if (denoCache !== null) return denoCache;
  const res = await run('deno', ['--version'], 10_000);
  if (res.code === 'ENOENT') return false; // may be installed later: do not cache
  denoCache = res.code === 0;
  return denoCache;
}

const YOUTUBE_HOST = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/;

export async function downloadVideo(
  rawUrl: string,
  ytdlp = process.env.ASISTENTA_YTDLP || 'yt-dlp',
  opts: { cookiesFromBrowser?: string } = {},
): Promise<DownloadResult> {
  const url = parsePublicUrl(rawUrl);
  if (!url) return { ok: false, reason: 'solo puedo descargar enlaces públicos http(s)' };
  const cookies = (COOKIE_BROWSERS as readonly string[]).includes(opts.cookiesFromBrowser ?? '')
    ? (opts.cookiesFromBrowser as string)
    : '';
  const dir = await mkdtemp(join(tmpdir(), 'asistenta-dl-'));
  try {
    let tooBig = false;
    // Looks like a real Chrome to sites that fingerprint TLS; null when yt-dlp cannot.
    let impersonate = await impersonateTarget(ytdlp);
    for (const height of HEIGHTS) {
      const args = (imp: string | null): string[] => [
        ...(imp ? ['--impersonate', imp] : []),
        ...(cookies ? ['--cookies-from-browser', cookies] : []),
        '--no-playlist',
        '--no-warnings',
        '--no-progress',
        '--socket-timeout',
        '30',
        '--max-filesize',
        String(MAX_UPLOAD_BYTES),
        '-f',
        formatFor(height),
        '--merge-output-format',
        'mp4',
        '-o',
        join(dir, 'video.%(ext)s'),
        '--print',
        'after_move:filepath',
        '--print',
        'title',
        '--print',
        'duration',
        '--',
        url.toString(),
      ];
      let res = await run(ytdlp, args(impersonate), VIDEO_TIMEOUT_MS);
      if (
        impersonate &&
        res.code !== 0 &&
        res.code !== 'ENOENT' &&
        /impersonat/i.test(res.stderr)
      ) {
        // The impersonation backend broke: the download is worth trying without it.
        log.warn('yt-dlp impersonation failed, retrying without it', {
          stderr: res.stderr.slice(0, 300),
        });
        impersonate = null;
        res = await run(ytdlp, args(null), VIDEO_TIMEOUT_MS);
      }
      if (res.code === 'ENOENT') {
        return {
          ok: false,
          reason:
            'no tengo yt-dlp instalado en este equipo (en Windows: winget install yt-dlp.yt-dlp y winget install Gyan.FFmpeg)',
        };
      }
      if (res.code !== 0) {
        if (/larger than max-filesize|max-filesize/i.test(res.stderr)) {
          tooBig = true;
          continue;
        }
        const youtube = YOUTUBE_HOST.test(url.hostname.toLowerCase());
        // The raw English message is the only diagnostic when the Spanish one is too coarse.
        log.warn('yt-dlp failed', { host: url.hostname, stderr: res.stderr.slice(0, 500) });
        return {
          ok: false,
          reason: explainYtdlpError(res.stderr, {
            cookies: cookies || undefined,
            youtube,
            deno: youtube ? await hasDeno() : undefined,
          }),
        };
      }
      // yt-dlp prints one line per --print, in the order given: the title and duration are
      // known before the download, the path only afterwards, so take the last path-like line.
      const lines = res.stdout.split(/\r?\n/).filter(Boolean);
      const filepath = lines.find((l) => l.startsWith(dir));
      if (!filepath) {
        // A file over --max-filesize is skipped without an error on some sites.
        tooBig = true;
        continue;
      }
      const info = await stat(filepath).catch(() => null);
      if (!info) {
        tooBig = true;
        continue;
      }
      if (info.size > MAX_UPLOAD_BYTES) {
        tooBig = true;
        continue;
      }
      const meta = lines.filter((l) => l !== filepath);
      const title = (meta[0] ?? 'Vídeo').slice(0, 200);
      const seconds = Math.max(0, Math.round(Number(meta[1]) || 0));
      const bytes = await readFile(filepath);
      return { ok: true, kind: 'video', bytes, title, seconds, filename: 'video.mp4' };
    }
    return {
      ok: false,
      reason: tooBig
        ? 'el vídeo pesa más de 50 MB incluso en baja calidad y Telegram no deja a los bots subir más'
        : 'no se pudo descargar',
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function filenameFrom(disposition: string | null, url: URL): string {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition ?? '');
  let name = m?.[1] ? safeDecode(m[1]) : decodeURIComponent(url.pathname.split('/').pop() || '');
  name = Array.from(name, (c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? '_' : c))
    .join('')
    .trim();
  if (!name) name = 'documento.pdf';
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export async function downloadPdf(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DownloadResult> {
  let url = parsePublicUrl(rawUrl);
  if (!url) return { ok: false, reason: 'solo puedo descargar enlaces públicos http(s)' };
  const signal = AbortSignal.timeout(PDF_TIMEOUT_MS);
  try {
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetchImpl(url.toString(), {
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; Asistenta/1.0)',
          accept: 'application/pdf,*/*;q=0.5',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return { ok: false, reason: 'el sitio redirige sin dar destino' };
        const next = parsePublicUrl(new URL(loc, url).toString());
        if (!next) return { ok: false, reason: 'el enlace redirige a una dirección no permitida' };
        url = next;
        res = null;
        continue;
      }
      break;
    }
    if (!res) return { ok: false, reason: 'demasiadas redirecciones' };
    if (!res.ok) return { ok: false, reason: `el sitio respondió con error ${res.status}` };
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        reason: 'el PDF pesa más de 50 MB y Telegram no deja a los bots subir más',
      };
    }
    // Stream with a hard cap: content-length can be missing or wrong.
    const chunks: Buffer[] = [];
    let total = 0;
    if (!res.body) return { ok: false, reason: 'el sitio no devolvió contenido' };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > MAX_UPLOAD_BYTES) {
        return {
          ok: false,
          reason: 'el PDF pesa más de 50 MB y Telegram no deja a los bots subir más',
        };
      }
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    // Trust the bytes, not the header: sites serve HTML login pages with a pdf name.
    if (bytes.subarray(0, 1024).indexOf('%PDF-') === -1) {
      return {
        ok: false,
        reason: 'ese enlace no devuelve un PDF (puede ser una página web o exigir iniciar sesión)',
      };
    }
    const filename = filenameFrom(res.headers.get('content-disposition'), url);
    return { ok: true, kind: 'pdf', bytes, title: filename, seconds: 0, filename };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: /abort|timeout/i.test(msg)
        ? 'el sitio tardó demasiado en responder'
        : 'fallo de red al descargar (el sitio no respondió bien)',
    };
  }
}

const PDF_URL = /\.pdf(?:$|[?#])/i;

/** Pick by link shape when the caller did not say: a .pdf path is a PDF, anything else a video. */
export async function downloadFromLink(
  rawUrl: string,
  kind: 'auto' | 'video' | 'pdf' = 'auto',
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const pdf = () => downloadPdf(rawUrl);
  const video = () =>
    downloadVideo(rawUrl, opts.ytdlp, { cookiesFromBrowser: opts.cookiesFromBrowser });
  if (kind === 'pdf') return pdf();
  if (kind === 'video') return video();
  if (PDF_URL.test(rawUrl)) {
    // A .pdf link is a PDF: if it fails, say why instead of asking yt-dlp for a video.
    return pdf();
  }
  return video();
}
