import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { localDay } from './datecontext.js';
import { paths } from './paths.js';
import { psErrorSummary } from './tools/ps-error.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Lee PA_LOG_LEVEL sin exigir minúsculas exactas: un .env editado en Windows
 * suele traer «WARN», «Debug» o espacios al final, y antes eso caía en `info`
 * sin avisar. `warning` vale como `warn`. Vacío = `info`. Un valor desconocido
 * también da `info`, pero `invalid` lo devuelve para avisar una vez.
 */
export function parseLogLevel(raw: string | undefined): { level: LogLevel; invalid?: string } {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return { level: 'info' };
  if (v === 'warning') return { level: 'warn' };
  if (Object.hasOwn(LEVEL_ORDER, v)) return { level: v as LogLevel };
  return { level: 'info', invalid: raw };
}

const parsedLevel = parseLogLevel(process.env.PA_LOG_LEVEL);
const threshold = LEVEL_ORDER[parsedLevel.level];
if (parsedLevel.invalid !== undefined) {
  process.stderr.write(
    `PA_LOG_LEVEL=${JSON.stringify(parsedLevel.invalid)} no es válido (debug | info | warn | error); uso info.\n`,
  );
}

/**
 * Tope por día del registro (log/AAAA-MM-DD.jsonl). Un bucle de errores podía
 * llenar el disco en un solo día: la poda por antigüedad viene apagada
 * (PA_FILE_RETENTION_DAYS=0) y no había tope de tamaño. Al llegar al tope se
 * escribe una sola línea de aviso y el resto del día solo va a la consola.
 */
const DEFAULT_DAY_MAX_MB = 50;

function dayMaxBytes(): number {
  const mb = Number(process.env.PA_LOG_DAY_MAX_MB ?? DEFAULT_DAY_MAX_MB);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : DEFAULT_DAY_MAX_MB * 1024 * 1024;
}

function dayCapMarker(ts: string): string {
  return JSON.stringify({
    ts,
    level: 'warn',
    msg: 'log del día lleno: no se escriben más líneas en este fichero hasta mañana',
    maxMb: dayMaxBytes() / (1024 * 1024),
  });
}

class DayCap {
  #day = '';
  #bytes = 0;
  #full = false;

  /** 'write', 'full-now' (escribe el aviso una vez) o 'skip'. */
  room(day: string, file: string, lineBytes: number): 'write' | 'full-now' | 'skip' {
    if (day !== this.#day) {
      this.#day = day;
      this.#full = false;
      // Tras un reinicio el fichero de hoy ya puede traer bytes.
      try {
        this.#bytes = statSync(file).size;
      } catch {
        this.#bytes = 0;
      }
    }
    if (this.#full) return 'skip';
    if (this.#bytes + lineBytes > dayMaxBytes()) {
      this.#full = true;
      return 'full-now';
    }
    this.#bytes += lineBytes;
    return 'write';
  }
}

const dayCap = new DayCap();

/**
 * JSONL to stdout plus a daily file. A daemon that only logs to stderr and
 * loses it is worse than one that has no logs; `npm`/NSSM capture both, so we
 * write both. Scrub at this final boundary too: callers may pass raw errors.
 */
function write(level: LogLevel, msg: string, fields: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const ts = new Date().toISOString();
  let line: string;
  try {
    const rec = { ...redact(fields), ts, level, msg: scrubLogValue(msg) };
    line = scrubUrls(JSON.stringify(rec));
  } catch {
    line = JSON.stringify({
      ts,
      level,
      msg: scrubLogValue(msg),
      note: 'fields were not serializable',
    });
  }
  process.stdout.write(`${line}\n`);
  try {
    mkdirSync(paths.log, { recursive: true });
    const day = localDay();
    const file = join(paths.log, `${day}.jsonl`);
    const room = dayCap.room(day, file, Buffer.byteLength(line) + 1);
    if (room === 'write') appendFileSync(file, `${line}\n`);
    else if (room === 'full-now') appendFileSync(file, `${dayCapMarker(ts)}\n`);
  } catch {
    // Never let logging be the reason a turn dies.
  }
}

/**
 * Enlaces http(s) dentro de un texto -> solo esquema y host. Una URL completa puede llevar
 * tokens (query, ruta firmada) y no debe quedar en el registro: ni en stderr de yt-dlp ni en
 * el mensaje de un Error. Se aplica a toda línea del registro.
 */
export function scrubUrls(text: string): string {
  // El userinfo (usuario:clave@) se descarta junto con la ruta y la query.
  return text.replace(
    /\b(https?:\/\/)(?:[^\s/"'\\<>?#@]*@)?([^\s/"'\\<>?#]+)[^\s"'\\<>]*/gi,
    '$1$2/…',
  );
}

export const log = {
  debug: (msg: string, fields: Record<string, unknown> = {}) => write('debug', msg, fields),
  info: (msg: string, fields: Record<string, unknown> = {}) => write('info', msg, fields),
  warn: (msg: string, fields: Record<string, unknown> = {}) => write('warn', msg, fields),
  error: (msg: string, fields: Record<string, unknown> = {}) => write('error', msg, fields),
};

const SECRET_KEY =
  /(key|token|secret|password|passwd|passphrase|pwd|authorization|cookie|cvv|card|contrase(?:ñ|n)a|clave)/i;
/** Nombres cortos que solo son credencial como nombre completo (`pass`, `pin`, `otp`). */
const SECRET_EXACT_KEY = /^(?:pass|pin|otp)$/i;
/**
 * Nombres que contienen esas letras sin ser credenciales: se tapaban y el registro
 * perdía diagnóstico (teclado de Telegram, tokens consumidos, «discard»). Lista cerrada
 * y por nombre completo: `token`, `apiKey`, `accessTokens`, `cardNumber`… siguen tapados.
 */
const INNOCENT_KEY =
  /^(?:keyboards?|discard(?:ed|s)?|cardinality|(?:input|output|total|max|prompt|completion|cached|reasoning|context)[_-]?tokens|tokens?[_-]?(?:count|used|total|limit))$/i;
const isSecretKey = (key: string): boolean =>
  SECRET_EXACT_KEY.test(key) || (SECRET_KEY.test(key) && !INNOCENT_KEY.test(key));
/**
 * Para un valor del registro (mensaje o campo): un error de execFile/exec copiado a texto
 * o re-envuelto en otro Error ya no lleva `cmd`. Tras «Command failed:» va la orden (un
 * script puede ocupar varias líneas) y luego stderr, que puede repetir el script: se omite
 * todo hasta el final del valor. Solo en el registro; scrubLogText sigue igual para otros usos.
 */
export function scrubLogValue(text: string): string {
  return scrubLogText(
    text.replace(/\bCommand failed: [\s\S]*/g, 'Command failed: [orden omitida]'),
  );
}

/** Recognizable credential formats only; arbitrary unlabelled secrets cannot be inferred. */
export function scrubLogText(text: string): string {
  return (
    scrubUrls(text)
      // Mensaje de execFile/exec copiado a texto: la primera línea es la orden entera.
      .replace(/\bCommand failed: [^\r\n]*/g, 'Command failed: [orden omitida]')
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/g,
        '[redacted]',
      )
      // Token de bot de Telegram (`123456789:AA…`, 35 caracteres tras los dos puntos) y
      // clave de Google/Gemini (`AIza…`): fuera de una URL no los tapaba nada.
      .replace(/\b\d{6,12}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, '[redacted]')
      .replace(/\bAIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g, '[redacted]')
      // También en castellano: «contraseña: …», «clave=…».
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, '$1 [redacted]')
      .replace(
        /\b(password|passwd|passphrase|pwd|token|secret|api[_-]?key|authorization|cookie|set-cookie|contrase(?:ñ|n)a|clave)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
        '$1=[redacted]',
      )
  );
}

/**
 * Best-effort recursive scrub of structured fields, including nested errors.
 * Applied by write() as well as exposed for callers. Does not mutate inputs.
 * This is a safety net, not permission to log credentials or arbitrary tool output.
 */
/** Campos que suelen llevar una línea de órdenes entera. */
const COMMAND_KEYS = ['cmd', 'command', 'commandLine', 'cmdline'];

export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const visit = (value: unknown, key = '', depth = 0): unknown => {
    if (isSecretKey(key)) return '[redacted]';
    if (typeof value === 'string') return scrubLogValue(value);
    if (typeof value !== 'object' || value === null) return value;
    if (seen.has(value)) return '[circular]';
    if (depth >= 20) return '[depth limit]';
    if (value instanceof Date) return value.toJSON();
    seen.add(value);
    try {
      if (value instanceof Error) {
        // Error de execFile/exec: `message` y `cmd` llevan la línea de órdenes entera
        // (script, títulos, texto del usuario, rutas). Solo código, señal y la primera
        // línea de stderr con lo entrecomillado tapado.
        const cmd = (value as { cmd?: unknown }).cmd;
        if (typeof cmd === 'string' && cmd.length > 0) {
          const { message: _m, stderr, ...rest } = psErrorSummary(value);
          return {
            name: scrubLogText(value.name),
            message: 'Command failed: [orden omitida]',
            ...rest,
            ...(stderr ? { stderr: scrubLogText(stderr) } : {}),
          };
        }
        return { name: scrubLogText(value.name), message: scrubLogValue(value.message) };
      }
      if (Array.isArray(value)) return value.map((v) => visit(v, '', depth + 1));
      // Objeto plano con la orden (p. ej. `{ ...err }` de execFile, o `{ cmd }`): la
      // orden se omite y la salida del proceso tampoco va entera (puede repetir el script).
      const plain = value as Record<string, unknown>;
      const hasCmd = COMMAND_KEYS.some((k) => typeof plain[k] === 'string' && plain[k] !== '');
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => {
          if (typeof v === 'string' && COMMAND_KEYS.includes(k)) return [k, '[orden omitida]'];
          if (hasCmd && typeof v === 'string' && k === 'stdout') return [k, '[omitido]'];
          if (hasCmd && typeof v === 'string' && k === 'stderr') {
            return [k, scrubLogText(psErrorSummary(plain).stderr ?? '')];
          }
          return [k, visit(v, k, depth + 1)];
        }),
      );
    } finally {
      seen.delete(value);
    }
  };
  return visit(fields) as Record<string, unknown>;
}

/** Solo el host de un enlace, para el registro: la URL completa puede llevar tokens. */
export function logHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'enlace-invalido';
  }
}
