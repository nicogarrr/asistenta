import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { log } from '../log.js';
import { isFetchable, isFetchableResolved } from '../tools/fetch.js';

/** Same narrowing as voice/decode.ts: typed as a module, a string at runtime. */
const FFMPEG: string | null =
  typeof ffmpegStatic === 'string'
    ? ffmpegStatic
    : ((ffmpegStatic as { default?: string }).default ?? null);

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
  | { ok: true; kind: 'audio'; bytes: Buffer; title: string; seconds: number; filename: string }
  | { ok: false; reason: string; status?: number; blocked?: boolean };

/** Optional anti-bot helpers. Everything here is off or auto-detected; see config.ts. */
export interface DownloadOptions {
  /** Path to yt-dlp; defaults to ASISTENTA_YTDLP or `yt-dlp` on PATH. */
  ytdlp?: string;
  /** Browser to read cookies from for yt-dlp (firefox, chrome, edge...). Empty = off. */
  cookiesFromBrowser?: string;
  /** Path to curl-impersonate. Empty = look for it on PATH. */
  curlImpersonatePath?: string;
}

// parsePublicUrl es solo léxico; antes de descargar, cada URL pasa además por
// isFetchableResolved (DNS: todas las IP deben ser públicas). Límite conocido: yt-dlp sigue
// sus propias redirecciones sin revalidar y el cliente vuelve a resolver al conectar.
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
  /** The caller asked for the audio track, not the video: wording says so. */
  audio?: boolean;
}

const DENO_STEP = 'instala deno (en Windows: winget install DenoLand.Deno) y reinicia el bot';
const COOKIES_STEP =
  'activa las cookies de un navegador donde tengas sesión iniciada (PA_DOWNLOAD_COOKIES_BROWSER=firefox)';

/** Turns yt-dlp's English stderr into something honest and short, in Spanish. */
export function explainYtdlpError(stderr: string, ctx: ExplainContext = {}): string {
  const s = stderr.toLowerCase();
  if (/unsupported url/.test(s)) {
    return ctx.audio
      ? 'ese enlace no tiene ningún vídeo ni audio que yo pueda descargar'
      : 'ese enlace no tiene ningún vídeo que yo pueda descargar';
  }
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
  // A 403 proves access was denied, not the cause.
  if (/http error 403|403: forbidden/.test(s)) {
    return ctx.cookies
      ? `el sitio me niega el acceso (error 403) aun con las cookies de ${ctx.cookies}; puede ser una protección anti-bot o un problema de sesión/permisos, prueba más tarde o descárgalo tú y mándamelo`
      : `el sitio me niega el acceso (error 403), probablemente una protección anti-bot; ${COOKIES_STEP}, o prueba más tarde`;
  }
  // Geo before "not available": "This video is not available in your country" is a
  // country block, not a removed video; the loose "not available" match must not win.
  if (/geo|country|your location/.test(s)) return 'el vídeo está bloqueado en tu país';
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

async function impersonateTarget(ytdlp: string, runImpl: typeof run = run): Promise<string | null> {
  if (impersonateCache.has(ytdlp)) return impersonateCache.get(ytdlp) ?? null;
  const res = await runImpl(ytdlp, ['--list-impersonate-targets'], 30_000);
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
  if (!url || !(await isFetchableResolved(url.toString()))) {
    return { ok: false, reason: 'solo puedo descargar enlaces públicos http(s)' };
  }
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

/** Safe `<title>.mp3` for Telegram, same character rules as filenameFrom. */
export function audioFilename(title: string): string {
  const name = safeFilename(title, 116) || 'audio';
  return /\.mp3$/i.test(name) ? name : `${name}.mp3`;
}

/**
 * "Quedate con el audio" of a link: yt-dlp takes the best audio track and ffmpeg
 * (ffmpeg-static, already a dependency for voice) re-encodes it to MP3. Same guards
 * as the video path: public http(s) only, the 50 MB Telegram cap, cookies and Chrome
 * impersonation exactly as configured. Nothing here bypasses DRM: yt-dlp itself
 * refuses protected streams and the error is reported as such.
 */
export async function downloadAudio(
  rawUrl: string,
  ytdlp = process.env.ASISTENTA_YTDLP || 'yt-dlp',
  opts: { cookiesFromBrowser?: string } = {},
  runImpl: typeof run = run,
): Promise<DownloadResult> {
  const url = parsePublicUrl(rawUrl);
  if (!url || !(await isFetchableResolved(url.toString()))) {
    return { ok: false, reason: 'solo puedo descargar enlaces públicos http(s)' };
  }
  if (!FFMPEG) {
    return {
      ok: false,
      reason: 'no puedo extraer el audio: falta ffmpeg (ffmpeg-static) en este equipo',
    };
  }
  const cookies = (COOKIE_BROWSERS as readonly string[]).includes(opts.cookiesFromBrowser ?? '')
    ? (opts.cookiesFromBrowser as string)
    : '';
  const dir = await mkdtemp(join(tmpdir(), 'asistenta-dl-'));
  try {
    const impersonate = await impersonateTarget(ytdlp, runImpl);
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
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '192K',
      '--ffmpeg-location',
      FFMPEG,
      '-o',
      join(dir, 'audio.%(ext)s'),
      '--print',
      'after_move:filepath',
      '--print',
      'title',
      '--print',
      'duration',
      '--',
      url.toString(),
    ];
    let res = await runImpl(ytdlp, args(impersonate), VIDEO_TIMEOUT_MS);
    if (impersonate && res.code !== 0 && res.code !== 'ENOENT' && /impersonat/i.test(res.stderr)) {
      // The impersonation backend broke: the extraction is worth trying without it.
      log.warn('yt-dlp impersonation failed, retrying without it', {
        stderr: res.stderr.slice(0, 300),
      });
      res = await runImpl(ytdlp, args(null), VIDEO_TIMEOUT_MS);
    }
    if (res.code === 'ENOENT') {
      return {
        ok: false,
        reason:
          'no tengo yt-dlp instalado en este equipo (en Windows: winget install yt-dlp.yt-dlp y winget install Gyan.FFmpeg)',
      };
    }
    if (res.code !== 0) {
      const youtube = YOUTUBE_HOST.test(url.hostname.toLowerCase());
      // The raw English message is the only diagnostic when the Spanish one is too coarse.
      log.warn('yt-dlp audio failed', { host: url.hostname, stderr: res.stderr.slice(0, 500) });
      return {
        ok: false,
        reason: explainYtdlpError(res.stderr, {
          cookies: cookies || undefined,
          youtube,
          deno: youtube ? await hasDeno() : undefined,
          audio: true,
        }),
      };
    }
    // Same --print contract as the video path: title and duration first, the path last.
    const lines = res.stdout.split(/\r?\n/).filter(Boolean);
    const filepath = lines.find((l) => l.startsWith(dir));
    if (!filepath) return { ok: false, reason: 'no se pudo extraer el audio' };
    const info = await stat(filepath).catch(() => null);
    if (!info) return { ok: false, reason: 'no se pudo extraer el audio' };
    if (info.size > MAX_UPLOAD_BYTES) {
      return {
        ok: false,
        reason: 'el audio pesa más de 50 MB y Telegram no deja a los bots subir más',
      };
    }
    const meta = lines.filter((l) => l !== filepath);
    const title = (meta[0] ?? 'Audio').slice(0, 200);
    const seconds = Math.max(0, Math.round(Number(meta[1]) || 0));
    const bytes = await readFile(filepath);
    return { ok: true, kind: 'audio', bytes, title, seconds, filename: audioFilename(title) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Nombre de fichero seguro para mandar a Telegram: sin controles, separadores ni
 * caracteres de Windows, sin marcas de dirección (U+202E y familia hacen que
 * «factura\u202Efdp.exe» se vea como otra extensión), sin puntos al principio y con
 * un tope de longitud. Vacío si no queda nada legible.
 */
export function safeFilename(raw: string, max = 120): string {
  let name = Array.from(raw, (c) => {
    const code = c.codePointAt(0) ?? 0;
    if (code < 32 || code === 127 || '\\/:*?"<>|'.includes(c)) return '_';
    if (/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(c)) return '';
    return c;
  })
    .join('')
    .trim()
    .replace(/^[.\s]+/, '');
  if (!/[\p{L}\p{N}]/u.test(name)) return '';
  if (name.length > max) name = Array.from(name).slice(0, max).join('').trim();
  return name;
}

/**
 * Nombre del PDF según Content-Disposition (RFC 6266: `filename*` manda sobre
 * `filename`, y su valor es `charset'idioma'texto-codificado`) o, si no hay, el final
 * de la ruta del enlace.
 */
export function filenameFrom(disposition: string | null, url: URL): string {
  const header = disposition ?? '';
  const star = /filename\*\s*=\s*"?([^";]*)'[^']*'([^";]+)"?/i.exec(header);
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  const raw = star?.[2]
    ? safeDecode(star[2])
    : plain
      ? (plain[1] ?? plain[2] ?? '').trim()
      : safeDecode(url.pathname.split('/').pop() || '');
  // Hueco para «.pdf» dentro del tope.
  const name = safeFilename(raw, 116) || 'documento';
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const BLOCK_STATUSES = new Set([403, 429, 503]);

/** Motivo en español para un error HTTP, para que el usuario sepa qué hacer. */
export function explainHttpStatus(status: number): string {
  if (status === 401)
    return 'el enlace exige iniciar sesión (error 401); descárgalo tú con tu cuenta y mándamelo';
  if (status === 403)
    return 'el sitio me niega el acceso (error 403): puede exigir sesión o ser una protección anti-bot';
  if (status === 404 || status === 410) return `ese enlace ya no existe (error ${status})`;
  if (status === 429)
    return 'el sitio me ha limitado por demasiadas peticiones (error 429); prueba en unos minutos';
  if (status >= 500)
    return `el sitio tiene un fallo ahora mismo (error ${status}); prueba más tarde`;
  return `el sitio respondió con error ${status}`;
}

const CAPTCHA_BODY =
  /just a moment|un momento\.\.\.|verify you are human|verifica que eres (?:un )?humano|captcha|are you a robot|no soy un robot|cf-chl|challenge-platform|attention required/i;
const LOGIN_BODY =
  /type=["']?password|iniciar sesi[oó]n|inicia sesi[oó]n|identif[ií]cate|sign in|log ?in\b|accede a tu cuenta/i;

/** Qué es probablemente la página que llegó en lugar de un PDF. */
export function explainNonPdfBody(head: string): string {
  const base = 'ese enlace no devuelve un PDF';
  if (CAPTCHA_BODY.test(head)) {
    return `${base}: parece un captcha o una comprobación anti-bot; ábrelo tú en el navegador, descárgalo y mándamelo`;
  }
  if (LOGIN_BODY.test(head)) {
    return `${base}: parece una página de inicio de sesión; descárgalo tú con tu cuenta y mándamelo`;
  }
  return `${base} (es una página web, no un fichero)`;
}

/** One full attempt (redirects, size cap, %PDF- check) through the given fetch. */
async function pdfAttempt(rawUrl: string, fetchImpl: typeof fetch): Promise<DownloadResult> {
  let url = parsePublicUrl(rawUrl);
  if (!url || !(await isFetchableResolved(url.toString()))) {
    return { ok: false, reason: 'solo puedo descargar enlaces públicos http(s)' };
  }
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
        if (!next || !(await isFetchableResolved(next.toString())))
          return { ok: false, reason: 'el enlace redirige a una dirección no permitida' };
        url = next;
        res = null;
        continue;
      }
      break;
    }
    if (!res) return { ok: false, reason: 'demasiadas redirecciones' };
    if (!res.ok) {
      return {
        ok: false,
        reason: explainHttpStatus(res.status),
        status: res.status,
        // A 403/429/503 or a Cloudflare mitigation header is usually an anti-bot wall.
        blocked: BLOCK_STATUSES.has(res.status) || res.headers.has('cf-mitigated'),
      };
    }
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
      return { ok: false, reason: explainNonPdfBody(bytes.subarray(0, 4096).toString('utf8')) };
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

/** Find curl-impersonate: the configured path, else `curl-impersonate(.exe)` on PATH. */
export async function findCurlImpersonate(configured = ''): Promise<string | null> {
  const exists = (f: string) =>
    access(f).then(
      () => true,
      () => false,
    );
  if (configured.trim()) return (await exists(configured.trim())) ? configured.trim() : null;
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of ['curl-impersonate.exe', 'curl-impersonate']) {
      const candidate = join(dir, name);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

/** curl-impersonate wants an exact version (the bare alias `chrome` is rejected, exit 43). */
const CURL_TARGETS = ['chrome146', 'chrome136', 'chrome131', 'chrome124'];

/**
 * A `fetch`-shaped function backed by curl-impersonate, so the same redirect, size and
 * %PDF- checks run unchanged. It never follows redirects itself: the caller revalidates
 * every hop with isFetchable.
 */
export function curlImpersonateFetch(bin: string): typeof fetch {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const dir = await mkdtemp(join(tmpdir(), 'asistenta-curl-'));
    try {
      const hdrFile = join(dir, 'headers.txt');
      const bodyFile = join(dir, 'body.bin');
      let code: number | 'ENOENT' = 1;
      for (const target of CURL_TARGETS) {
        const res = await run(
          bin,
          [
            '--impersonate',
            target,
            '--silent',
            '--show-error',
            '--proto',
            '=http,https',
            '--max-time',
            String(PDF_TIMEOUT_MS / 1000),
            '--max-filesize',
            String(MAX_UPLOAD_BYTES),
            '-D',
            hdrFile,
            '-o',
            bodyFile,
            '--',
            url,
          ],
          PDF_TIMEOUT_MS + 5_000,
        );
        code = res.code;
        if (code !== 43) break; // 43: this build does not know that target, try an older one
      }
      if (code === 28) throw new Error('timeout');
      if (code === 63) {
        // Over --max-filesize: report it the way the size check already understands.
        return new Response(null, {
          status: 200,
          headers: { 'content-length': String(MAX_UPLOAD_BYTES + 1) },
        });
      }
      if (code !== 0) throw new Error(`curl-impersonate falló (${String(code)})`);
      const head = await readFile(hdrFile, 'utf8');
      // Several header blocks can appear (proxy, 100-continue): the last one is the answer.
      const blocks = head.split(/\r?\n\r?\n/).filter((b) => /^HTTP\//.test(b.trim()));
      const lines = (blocks[blocks.length - 1] ?? '').trim().split(/\r?\n/);
      const status = Number(/^HTTP\/[\d.]+\s+(\d{3})/.exec(lines[0] ?? '')?.[1]);
      if (!Number.isInteger(status) || status < 200 || status > 599) {
        throw new Error('respuesta de curl-impersonate ilegible');
      }
      const headers = new Headers();
      for (const line of lines.slice(1)) {
        const i = line.indexOf(':');
        if (i > 0) headers.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
      }
      const body = await readFile(bodyFile).catch(() => Buffer.alloc(0));
      const noBody = status === 204 || status === 205 || status === 304;
      return new Response(noBody ? null : new Uint8Array(body), { status, headers });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export async function downloadPdf(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
  opts: { curlFetch?: typeof fetch | null; curlImpersonatePath?: string } = {},
): Promise<DownloadResult> {
  const first = await pdfAttempt(rawUrl, fetchImpl);
  if (first.ok || !first.blocked) return first;

  // An anti-bot wall answered. Retry once as a real Chrome would, if the tool is here.
  let viaCurl = opts.curlFetch;
  if (viaCurl === undefined) {
    const bin = await findCurlImpersonate(opts.curlImpersonatePath);
    viaCurl = bin ? curlImpersonateFetch(bin) : null;
  }
  if (!viaCurl) {
    return {
      ok: false,
      status: first.status,
      reason:
        `el sitio bloquea las descargas automáticas (error ${first.status ?? '?'}, parece una protección anti-bot). ` +
        'Puedo reintentarlo imitando a Chrome si instalas curl-impersonate ' +
        '(https://github.com/lexiforest/curl-impersonate/releases) y pones su ruta en PA_CURL_IMPERSONATE o en el PATH; ' +
        'si no, descárgalo tú y mándamelo',
    };
  }
  const second = await pdfAttempt(rawUrl, viaCurl);
  if (second.ok) return second;
  if (second.blocked) {
    return {
      ok: false,
      status: second.status,
      reason: `el sitio sigue bloqueándome aunque imito a Chrome (error ${second.status ?? '?'}); seguramente pide un captcha o iniciar sesión, así que tendrás que descargarlo tú`,
    };
  }
  return second;
}

const PDF_URL = /\.pdf(?:$|[?#])/i;

/** Pick by link shape when the caller did not say: a .pdf path is a PDF, anything else a video. */
export async function downloadFromLink(
  rawUrl: string,
  kind: 'auto' | 'video' | 'pdf' | 'audio' = 'auto',
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const pdf = () =>
    downloadPdf(rawUrl, fetch, { curlImpersonatePath: opts.curlImpersonatePath ?? '' });
  const video = () =>
    downloadVideo(rawUrl, opts.ytdlp, { cookiesFromBrowser: opts.cookiesFromBrowser });
  if (kind === 'pdf') return pdf();
  if (kind === 'video') return video();
  if (kind === 'audio') {
    return downloadAudio(rawUrl, opts.ytdlp, { cookiesFromBrowser: opts.cookiesFromBrowser });
  }
  if (PDF_URL.test(rawUrl)) {
    // A .pdf link is a PDF: if it fails, say why instead of asking yt-dlp for a video.
    return pdf();
  }
  return video();
}
