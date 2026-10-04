import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVEL_ORDER[(process.env.PA_LOG_LEVEL as LogLevel) ?? 'info'] ?? 20;

/**
 * JSONL to stdout plus a daily file. A daemon that only logs to stderr and
 * loses it is worse than one that has no logs; `npm`/NSSM capture both, so we
 * write both. Redaction happens at the call site (`redact`), never here.
 */
function write(level: LogLevel, msg: string, fields: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < threshold) return;
  const rec = { ts: new Date().toISOString(), level, msg, ...fields };
  let line: string;
  try {
    line = scrubUrls(JSON.stringify(rec));
  } catch {
    line = JSON.stringify({ ts: rec.ts, level, msg, note: 'fields were not serializable' });
  }
  process.stdout.write(`${line}\n`);
  try {
    mkdirSync(paths.log, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
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
  return text.replace(/\b(https?:\/\/[^\s/"'\\<>?#]+)[^\s"'\\<>]*/gi, '$1/…');
}

export const log = {
  debug: (msg: string, fields: Record<string, unknown> = {}) => write('debug', msg, fields),
  info: (msg: string, fields: Record<string, unknown> = {}) => write('info', msg, fields),
  warn: (msg: string, fields: Record<string, unknown> = {}) => write('warn', msg, fields),
  error: (msg: string, fields: Record<string, unknown> = {}) => write('error', msg, fields),
};

const SECRET_KEY = /(key|token|secret|password|authorization|cookie|cvv|card)/i;
const SECRET_VALUE = /^(sk-|ghp_|xox[baprs]-|Bearer\s)/i;

/**
 * Best-effort scrub before anything reaches a log file. This is a safety net for
 * accidents, not a guarantee: secrets must not be passed as log fields in the
 * first place. `redact()` in vault.ts is the real boundary.
 */
export function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string' && (SECRET_KEY.test(k) || SECRET_VALUE.test(v))) {
      out[k] = '[redacted]';
    } else if (v instanceof Error) {
      out[k] = { name: v.name, message: v.message };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Solo el host de un enlace, para el registro: la URL completa puede llevar tokens. */
export function logHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'enlace-invalido';
  }
}
