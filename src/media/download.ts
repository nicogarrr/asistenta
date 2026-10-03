import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFetchable } from '../tools/fetch.js';

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
        resolve({ stdout, stderr: stderr || String(err.message), code: 1 });
      },
    );
  });
}

/** Turns yt-dlp's English stderr into something honest and short, in Spanish. */
export function explainYtdlpError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (/unsupported url/.test(s)) return 'ese enlace no tiene ningún vídeo que yo pueda descargar';
  if (/private|login|sign in|log in|authentication|cookies/.test(s))
    return 'el vídeo es privado o exige iniciar sesión, y no puedo descargarlo sin tu cuenta';
  if (/age[- ]restricted|confirm your age/.test(s)) return 'el vídeo tiene restricción de edad';
  if (
    /video unavailable|not available|has been removed|was deleted|does not exist|http error 404/.test(
      s,
    )
  )
    return 'el vídeo ya no está disponible';
  if (/geo|country|your location/.test(s)) return 'el vídeo está bloqueado en tu país';
  if (/drm/.test(s)) return 'el vídeo tiene protección DRM';
  if (/http error 429|too many requests|rate[- ]limit/.test(s))
    return 'el sitio me ha limitado por demasiadas peticiones; prueba en unos minutos';
  if (/timed out|timeout/.test(s)) return 'el sitio tardó demasiado en responder';
  if (/no video|no media|there is no video/.test(s)) return 'en ese enlace no hay vídeo';
  return 'yt-dlp no pudo descargarlo (el sitio puede haber cambiado; actualizar yt-dlp suele arreglarlo)';
}

export async function downloadVideo(
  rawUrl: string,
  ytdlp = process.env.ASISTENTA_YTDLP || 'yt-dlp',
): Promise<DownloadResult> {
  const url = parsePublicUrl(rawUrl);
  if (!url) return { ok: false, reason: 'solo puedo descargar enlaces públicos http(s)' };
  const dir = await mkdtemp(join(tmpdir(), 'asistenta-dl-'));
  try {
    let tooBig = false;
    for (const height of HEIGHTS) {
      const res = await run(
        ytdlp,
        [
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
        ],
        VIDEO_TIMEOUT_MS,
      );
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
        return { ok: false, reason: explainYtdlpError(res.stderr) };
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
): Promise<DownloadResult> {
  if (kind === 'pdf') return downloadPdf(rawUrl);
  if (kind === 'video') return downloadVideo(rawUrl);
  if (PDF_URL.test(rawUrl)) {
    // A .pdf link is a PDF: if it fails, say why instead of asking yt-dlp for a video.
    return downloadPdf(rawUrl);
  }
  return downloadVideo(rawUrl);
}
