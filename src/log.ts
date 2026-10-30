import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { localDay } from './datecontext.js';
import { paths } from './paths.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVEL_ORDER[(process.env.PA_LOG_LEVEL as LogLevel) ?? 'info'] ?? 20;

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
    const rec = { ...redact(fields), ts, level, msg: scrubLogText(msg) };
    line = scrubUrls(JSON.stringify(rec));
  } catch {
    line = JSON.stringify({
      ts,
      level,
      msg: scrubLogText(msg),
      note: 'fields were not serializable',
    });
  }
  process.stdout.write(`${line}\n`);
  try {
    mkdirSync(paths.log, { recursive: true });
    const day = localDay();
    appendFileSync(join(paths.log, `${day}.jsonl`), `${line}\n`);
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

const SECRET_KEY = /(key|token|secret|password|authorization|cookie|cvv|card)/i;
/**
 * Nombres que contienen esas letras sin ser credenciales: se tapaban y el registro
 * perdía diagnóstico (teclado de Telegram, tokens consumidos, «discard»). Lista cerrada
 * y por nombre completo: `token`, `apiKey`, `accessTokens`, `cardNumber`… siguen tapados.
 */
const INNOCENT_KEY =
  /^(?:keyboards?|discard(?:ed|s)?|cardinality|(?:input|output|total|max|prompt|completion|cached|reasoning|context)[_-]?tokens|tokens?[_-]?(?:count|used|total|limit))$/i;
const isSecretKey = (key: string): boolean => SECRET_KEY.test(key) && !INNOCENT_KEY.test(key);
/** Recognizable credential formats only; arbitrary unlabelled secrets cannot be inferred. */
export function scrubLogText(text: string): string {
  return (
    scrubUrls(text)
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/g,
        '[redacted]',
      )
      // Token de bot de Telegram (`123456789:AA…`, 35 caracteres tras los dos puntos) y
      // clave de Google/Gemini (`AIza…`): fuera de una URL no los tapaba nada.
      .replace(/\b\d{6,12}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, '[redacted]')
      .replace(/\bAIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g, '[redacted]')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, '$1 [redacted]')
      .replace(
        /\b(password|passwd|pwd|token|secret|api[_-]?key|authorization|cookie|set-cookie)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
        '$1=[redacted]',
      )
  );
}

/**
 * Best-effort recursive scrub of structured fields, including nested errors.
 * Applied by write() as well as exposed for callers. Does not mutate inputs.
 * This is a safety net, not permission to log credentials or arbitrary tool output.
 */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const visit = (value: unknown, key = '', depth = 0): unknown => {
    if (isSecretKey(key)) return '[redacted]';
    if (typeof value === 'string') return scrubLogText(value);
    if (typeof value !== 'object' || value === null) return value;
    if (seen.has(value)) return '[circular]';
    if (depth >= 20) return '[depth limit]';
    if (value instanceof Date) return value.toJSON();
    seen.add(value);
    try {
      if (value instanceof Error) {
        return { name: scrubLogText(value.name), message: scrubLogText(value.message) };
      }
      if (Array.isArray(value)) return value.map((v) => visit(v, '', depth + 1));
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, visit(v, k, depth + 1)]));
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
