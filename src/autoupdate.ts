/**
 * Autoactualización (PA_AUTOUPDATE, encendida por defecto; PA_AUTOUPDATE=0 la apaga).
 *
 * El vigilante de Windows (autostart-watchdog.ts) la lanza cada PA_AUTOUPDATE_INTERVAL_MIN
 * (30 por defecto). Si origin/main va por delante, el árbol está limpio, estamos en main y
 * el avance es fast-forward, espera a que Asistenta esté libre, para el daemon, hace
 * `git merge --ff-only`, `npm ci` (solo si cambió package-lock.json) y `npm run build`, y lo
 * vuelve a arrancar por la misma tarea que usa el vigilante. Si algo falla, o el daemon no
 * vuelve sano, deja el commit y el dist de antes y avisa por Telegram.
 *
 * Nunca hace merge de verdad, nunca resetea encima de cambios locales y nunca toca otra rama.
 * Todo efecto (git, npm, daemon, Telegram) llega inyectado: los tests no ejecutan nada real.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { BUSY_DIR } from './ocupada.js';

export const AUTOUPDATE_DIR = BUSY_DIR;
export const AUTOUPDATE_STATE_FILE = 'estado.json';
export const AUTOUPDATE_LOCK_FILE = 'en-curso.lock';
/** Como mucho una actualización cada 30 min, aunque el intervalo de revisión sea menor. */
export const MIN_GAP_MS = 30 * 60_000;
/** Un candado más viejo que esto es de un proceso que murió. */
export const LOCK_STALE_MS = 45 * 60_000;
export const HEALTH_TIMEOUT_MS = 120_000;
export const CHANGELOG_MAX = 8;

const OFF = ['0', 'false', 'no', 'off'];

export function autoupdateEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !OFF.includes((env.PA_AUTOUPDATE ?? '').trim().toLowerCase());
}

export function autoupdateIntervalMin(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env.PA_AUTOUPDATE_INTERVAL_MIN ?? '').trim() || 30);
  return Number.isFinite(n) ? Math.min(1440, Math.max(5, Math.round(n))) : 30;
}

export type OutcomeKind = 'al-dia' | 'actualizada' | 'omitida' | 'aplazada' | 'revertida' | 'error';
export interface Outcome {
  kind: OutcomeKind;
  text: string;
}
export interface AutoupdateState {
  off?: boolean;
  lastCheckAt?: string;
  lastUpdateAt?: string;
  last?: Outcome & { at: string };
}

const dir = (stateDir: string) => join(stateDir, AUTOUPDATE_DIR);

export function readAutoupdateState(stateDir: string): AutoupdateState {
  try {
    const raw = JSON.parse(readFileSync(join(dir(stateDir), AUTOUPDATE_STATE_FILE), 'utf8'));
    return raw && typeof raw === 'object' ? (raw as AutoupdateState) : {};
  } catch {
    return {};
  }
}

export function writeAutoupdateState(stateDir: string, state: AutoupdateState): void {
  try {
    mkdirSync(dir(stateDir), { recursive: true });
    const file = join(dir(stateDir), AUTOUPDATE_STATE_FILE);
    writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(state));
    renameSync(`${file}.${process.pid}.tmp`, file);
  } catch {
    // Solo es diagnóstico y el interruptor on/off; sin él se usa el valor por defecto.
  }
}

export function autoupdateEnabled(stateDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return autoupdateEnvEnabled(env) && readAutoupdateState(stateDir).off !== true;
}

/** Toca revisar: nunca se revisó o la última revisión es más vieja que el intervalo. */
export function autoupdateDue(state: AutoupdateState, now: number, intervalMin: number): boolean {
  const last = state.lastCheckAt ? Date.parse(state.lastCheckAt) : Number.NaN;
  return Number.isNaN(last) || now - last >= intervalMin * 60_000 || last > now;
}

export function lockHeld(stateDir: string, now: number = Date.now()): boolean {
  try {
    return now - statSync(join(dir(stateDir), AUTOUPDATE_LOCK_FILE)).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** Candado exclusivo (O_EXCL): dos revisiones nunca se pisan. Uno caducado se reemplaza. */
export function tryLock(stateDir: string, now: number = Date.now()): boolean {
  const file = join(dir(stateDir), AUTOUPDATE_LOCK_FILE);
  for (let i = 0; i < 2; i++) {
    try {
      mkdirSync(dir(stateDir), { recursive: true });
      closeSync(openSync(file, 'wx'));
      writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }));
      return true;
    } catch {
      if (lockHeld(stateDir, now)) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
}

export function unlock(stateDir: string): void {
  rmSync(join(dir(stateDir), AUTOUPDATE_LOCK_FILE), { force: true });
}

/** «feat(tele): sube a tope (#712)» → «Sube a tope». */
export function cleanSubject(subject: string): string {
  let s = subject
    .trim()
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '')
    .replace(/\s*\(#\d+\)\s*$/, '')
    .trim();
  if (s.length > 110) s = `${s.slice(0, 109).trimEnd()}…`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatChangelog(subjects: string[], max: number = CHANGELOG_MAX): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of subjects) {
    const s = cleanSubject(raw);
    if (!s || /^merge (pull request|branch|remote-tracking)/i.test(s)) continue;
    if (seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    items.push(s);
  }
  if (!items.length) return ['• Cambios internos'];
  const lines = items.slice(0, max).map((s) => `• ${s}`);
  const rest = items.length - max;
  if (rest > 0) lines.push(`y ${rest} ${rest === 1 ? 'cambio' : 'cambios'} más`);
  return lines;
}

export function successMessage(subjects: string[]): string {
  return ['🆕 Me he actualizado', ...formatChangelog(subjects)].join('\n');
}

export function failureMessage(reason: string): string {
  return `⚠️ No he podido actualizarme: ${reason}. Sigo con la versión anterior.\nDetalle: pa autoupdate status`;
}
