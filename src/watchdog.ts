/**
 * The daemon watching itself — from a process that is NOT the daemon.
 *
 * `lifecycle.ts` already writes a heartbeat every 15s. What it cannot do is notice
 * that it stopped writing: a dead process has no timer left to complain with, and a
 * hung one is the same thing from the outside. So this module is deliberately a
 * standalone class with no import from `lifecycle.ts` and no import from the daemon's
 * CLI, meant to be instantiated by a launcher that lives in a different process
 * (`node dist/cli.js watchdog`). A watchdog that ran inside the daemon would be
 * killing the very process it is trying to supervise, which is a hang, not a fix.
 *
 * Three things this file exists to get right, in order of importance:
 *
 * 1. **The threshold is a multiple of the write interval, with a floor.** 3x15s would
 *    be "dead" after 45 seconds, which a GC pause, a long tool call or a suspended
 *    laptop produces routinely. The 120s floor is what makes the number trustworthy:
 *    a verdict of "dead" has to mean dead, not "busy".
 * 2. **The restart loop is bounded (see {@link WatchdogOptions.maxRestarts}).** A
 *    daemon that crashes on boot because of a bad config would otherwise be restarted
 *    forever, burning CPU and filling the disk with the same stack trace while the user
 *    sleeps. Past the budget the watchdog stops restarting and reports instead: a
 *    crash-loop must reach a human, not be consumed by an infinite loop.
 * 3. **A pid that cannot be read is never killed.** Guessing a pid is how a watchdog
 *    takes down an unrelated process, so an unreadable pid degrades to "report" and
 *    touches nothing.
 *
 * Every side effect (kill, restart, notify) is injected. That is not for testability
 * alone: the restart strategy differs per platform (Task Scheduler, systemd, launchd),
 * so the launcher owns it and this module only decides *whether*.
 */

import { readFileSync, statSync } from 'node:fs';
import { log } from './log.js';
import { sameProcessAsRecorded } from './process-identity.js';

/** A beat this far ahead of the clock was written before the clock went back. */
const FUTURE_BEAT_TOLERANCE_MS = 60_000;

/**
 * Heartbeat cadence, mirrored from `installLifecycle`'s `setInterval`. Duplicated
 * rather than imported because a watchdog that imports the daemon's lifecycle module
 * inherits its dependencies, and the whole point of this file is to be loadable from
 * a bare process that only wants to watch.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Never declare the daemon dead sooner than this, whatever the interval says.
 *
 * A turn can legitimately block the event loop for a while (a synchronous ffmpeg
 * call, a huge file read, a browser screenshot encode). Judging on interval alone
 * means restarting a daemon that is merely busy, which turns a slow turn into a
 * killed turn, and a killed turn into a user-visible failure.
 */
export const MIN_STALE_MS = 120_000;

/** How many missed beats before a heartbeat counts as dead. */
export const STALE_BEATS = 3;

/** Restarts allowed inside {@link WatchdogOptions.windowMs} before giving up. */
export const DEFAULT_MAX_RESTARTS = 5;

/** Length of the sliding window the restart budget is spent over. */
export const DEFAULT_WINDOW_MS = 15 * 60_000;

/** Threshold for a given write interval: 3 missed beats, never under the floor. */
export function staleThresholdMs(intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS): number {
  return Math.max(MIN_STALE_MS, Math.max(0, intervalMs) * STALE_BEATS);
}

export type WatchdogAction = 'none' | 'restart' | 'report';

export interface WatchdogVerdict {
  /** Heartbeat newer than the threshold (or status-only look, same test). */
  healthy: boolean;
  /** Age of the heartbeat. `Infinity` when there has never been one. */
  staleMs: number;
  /** Restarts performed inside the window, before this verdict was reached. */
  restarts: number;
  /** True once the restart budget is spent: the watchdog has stopped restarting. */
  gaveUp: boolean;
  action: WatchdogAction;
  /** Why, in Spanish, because this ends up pasted into a chat. */
  reason: string;
  /** Pid the watchdog saw, or null when unknown. */
  pid: number | null;
}

export interface WatchdogStats {
  healthy: boolean;
  staleMs: number;
  staleAfterMs: number;
  lastHeartbeatAt: string | null;
  lastHeartbeatSource: HeartbeatSource;
  pid: number | null;
  /** Restarts since this Watchdog was created. */
  restarts: number;
  /** Restarts still inside the window, i.e. what the budget is being spent from. */
  restartsInWindow: number;
  maxRestarts: number;
  windowMs: number;
  gaveUp: boolean;
  lastAction: WatchdogAction;
  lastCheckAt: string | null;
  lastError: string | null;
  statusOnly: boolean;
}

export interface WatchdogOptions {
  /** File `installLifecycle` writes the heartbeat into. */
  heartbeatFile: string;
  /** Daemon pid file. Its presence makes an unreadable pid a report, not a guess. */
  pidFile?: string;
  /** Heartbeat age above which the daemon counts as dead. See {@link staleThresholdMs}. */
  staleAfterMs?: number;
  /** Restarts allowed per window before the watchdog gives up. */
  maxRestarts?: number;
  /** Sliding window the restart budget is spent over. */
  windowMs?: number;
  now?: () => number;
  /**
   * Read the daemon pid. Injected instead of read directly so a test can say "the pid
   * file is unreadable" without racing a real process. Defaults to `pidFile`.
   */
  readPid?: () => number | null;
  /** Terminate a process that is alive but not beating. Defaults to `process.kill`. */
  kill?: (pid: number) => void | Promise<void>;
  /** Bring the daemon back. Owned by the launcher: Task Scheduler, systemd, launchd. */
  restart: () => void | Promise<void>;
  /** Used to derive the default threshold. See {@link DEFAULT_HEARTBEAT_INTERVAL_MS}. */
  heartbeatIntervalMs?: number;
  /** `--status`: look and report, never kill and never restart. */
  statusOnly?: boolean;
  /** Where a report goes (Telegram, in practice). Called at most once per report. */
  onReport?: (message: string, verdict: WatchdogVerdict) => void | Promise<void>;
  /** One line about the last turn, so the report says what was interrupted. */
  lastTurn?: () => string | null;
  /** Human name used in the reports. */
  daemonName?: string;
}

export type HeartbeatSource = 'content' | 'mtime' | 'missing';

export interface Heartbeat {
  /** Epoch ms of the last beat, or null when there is no heartbeat file at all. */
  at: number | null;
  source: HeartbeatSource;
}

/**
 * Read a heartbeat without trusting its format.
 *
 * `lifecycle.ts` writes `String(Date.now())`, but the file survives a version that
 * changed the format, and a hand-edited file should degrade to "old" rather than to
 * "healthy". So: a plausible number wins, the mtime is the fallback, and anything
 * else is a missing heartbeat.
 */
export function readHeartbeat(file: string): Heartbeat {
  let mtimeMs: number | null = null;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return { at: null, source: 'missing' };
  }
  try {
    const parsed = Number(readFileSync(file, 'utf8').trim());
    // Sanity bounds: epoch ms between 2001 and 2100. Anything else is not a beat.
    if (Number.isFinite(parsed) && parsed > 1e12 && parsed < 4.1e12) {
      return { at: parsed, source: 'content' };
    }
  } catch {
    // Fall through to the mtime.
  }
  return { at: mtimeMs, source: 'mtime' };
}

function defaultReadPid(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * `SIGTERM` on Windows is TerminateProcess: the target gets no chance to release its
 * channel sessions. That is acceptable *here* and only here, because a watchdog that
 * had to be polite would be pointless — a daemon that can answer a shutdown request is
 * not the daemon that needed a watchdog. ESRCH is the success case here: the goal is
 * "that process is not running", and it already is.
 */
function defaultKill(pid: number): void {
  try {
    process.kill(pid);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

/**
 * The default kill when the watchdog knows the pid file: a pid left by a crash
 * may now belong to another program (Windows reuses pids quickly), and killing
 * it would take down whatever the user has open. If the start identity the
 * daemon recorded at boot (`<pid file>.start`) proves the live process started
 * at another moment, it is left alone; the restart that follows goes through
 * `assertNotRunning`, which makes the same check.
 */
export function killIfOurs(
  pid: number,
  pidFile: string,
  deps: {
    identityOf?: (pid: number) => string | null;
    kill?: (pid: number) => void;
  } = {},
): void {
  if (sameProcessAsRecorded(`${pidFile}.start`, pid, deps.identityOf) === 'different') {
    log.warn('watchdog: the pid in the pid file now belongs to another process; not killing it', {
      pid,
    });
    return;
  }
  (deps.kill ?? defaultKill)(pid);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Human duration in Spanish: `45 segundos`, `12 minutos`, `1 hora y 3 minutos`. */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) return 'sin latido nunca';
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return plural(total, 'segundo', 'segundos');
  const minutes = Math.floor(total / 60);
  const restSeconds = total % 60;
  if (minutes < 60) {
    return restSeconds > 0 && minutes < 5
      ? `${plural(minutes, 'minuto', 'minutos')} y ${plural(restSeconds, 'segundo', 'segundos')}`
      : plural(minutes, 'minuto', 'minutos');
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0
    ? `${plural(hours, 'hora', 'horas')} y ${plural(restMinutes, 'minuto', 'minutos')}`
    : plural(hours, 'hora', 'horas');
}

export class Watchdog {
  readonly #opts: {
    heartbeatFile: string;
    pidFile: string | undefined;
    staleAfterMs: number;
    maxRestarts: number;
    windowMs: number;
    now: () => number;
    readPid: () => number | null;
    kill: (pid: number) => void | Promise<void>;
    restart: () => void | Promise<void>;
    statusOnly: boolean;
    onReport: ((message: string, verdict: WatchdogVerdict) => void | Promise<void>) | undefined;
    lastTurn: () => string | null;
    daemonName: string;
    /** Whether a pid is expected at all. Without one there is nothing to kill. */
    pidExpected: boolean;
  };

  /** Timestamps of restarts still inside the window. */
  #futureBeat: { at: number; seenAt: number } | null = null;
  #window: number[] = [];
  #totalRestarts = 0;
  #gaveUp = false;
  #lastAction: WatchdogAction = 'none';
  #lastCheckAt: number | null = null;
  #lastHeartbeatAt: number | null = null;
  #lastSource: HeartbeatSource = 'missing';
  #lastPid: number | null = null;
  #lastStaleMs = Number.POSITIVE_INFINITY;
  #lastError: string | null = null;

  constructor(options: WatchdogOptions) {
    const pidFile = options.pidFile;
    this.#opts = {
      heartbeatFile: options.heartbeatFile,
      pidFile,
      staleAfterMs: Math.max(
        1_000,
        options.staleAfterMs ?? staleThresholdMs(options.heartbeatIntervalMs),
      ),
      maxRestarts: Math.max(0, options.maxRestarts ?? DEFAULT_MAX_RESTARTS),
      windowMs: Math.max(1_000, options.windowMs ?? DEFAULT_WINDOW_MS),
      now: options.now ?? Date.now,
      readPid:
        options.readPid ?? (pidFile !== undefined ? () => defaultReadPid(pidFile) : () => null),
      kill:
        options.kill ?? (pidFile !== undefined ? (pid) => killIfOurs(pid, pidFile) : defaultKill),
      restart: options.restart,
      statusOnly: options.statusOnly === true,
      onReport: options.onReport,
      lastTurn: options.lastTurn ?? (() => null),
      daemonName: options.daemonName ?? 'Asistenta',
      pidExpected: options.readPid !== undefined || options.pidFile !== undefined,
    };
  }

  /** The threshold in force, so a launcher can print it in `--status`. */
  get staleAfterMs(): number {
    return this.#opts.staleAfterMs;
  }

  get maxRestarts(): number {
    return this.#opts.maxRestarts;
  }

  /**
   * Look, then act once.
   *
   * Everything that can wait is sequenced after the decision, so a check that finds a
   * healthy daemon never touches a process. The kill happens before the restart and
   * both are awaited: starting a second daemon next to a hung one is the exact race
   * `assertNotRunning` exists to prevent, and letting it happen would turn one dead
   * daemon into two fighting ones.
   */
  async check(): Promise<WatchdogVerdict> {
    const verdict = this.#inspect();
    if (verdict.action !== 'restart') {
      // `report` covers three different refusals (budget spent, pid unreadable, status
      // mode) and none of them may fall through into the restart path: a watchdog that
      // restarts after deciding to report is a watchdog that decided nothing.
      this.#lastAction = verdict.action;
      return verdict;
    }
    try {
      if (verdict.pid !== null) await this.#opts.kill(verdict.pid);
      await this.#opts.restart();
      const now = this.#opts.now();
      this.#window.push(now);
      this.#totalRestarts += 1;
      this.#gaveUp = false;
      this.#lastError = null;
      this.#lastAction = 'restart';
      return { ...verdict, healthy: false, restarts: this.#window.length, action: 'restart' };
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err);
      this.#lastAction = 'report';
      log.error('watchdog restart failed', { err: this.#lastError });
      return {
        ...verdict,
        healthy: false,
        restarts: this.#window.length,
        action: 'report',
        reason: 'intenté reiniciarla y no pude',
      };
    }
  }

  /**
   * How long the daemon has gone without a beat. A beat dated in the future means the
   * clock went back after it was written (a fast clock corrected by Windows time sync,
   * dual boot with Linux): counted from now - at it would read as fresh until the clock
   * catches up, so a daemon that hung after the correction was never restarted. Such a
   * beat counts from the moment we first saw it; a live daemon rewrites it within 15 s.
   */
  #staleness(at: number | null, now: number): number {
    if (at === null) return Number.POSITIVE_INFINITY;
    if (at - now <= FUTURE_BEAT_TOLERANCE_MS) {
      this.#futureBeat = null;
      return Math.max(0, now - at);
    }
    if (this.#futureBeat?.at !== at) this.#futureBeat = { at, seenAt: now };
    return Math.max(0, now - this.#futureBeat.seenAt);
  }

  /** Everything `check()` would decide, without touching a process. */
  #inspect(): WatchdogVerdict {
    const now = this.#opts.now();
    this.#lastCheckAt = now;
    const beat = readHeartbeat(this.#opts.heartbeatFile);
    this.#lastHeartbeatAt = beat.at;
    this.#lastSource = beat.source;
    const staleMs = this.#staleness(beat.at, now);
    this.#lastStaleMs = staleMs;
    this.#prune(now);
    // Read on every check, healthy or not: the pid is what lets a report name the
    // process, and the file read is the same cost as the heartbeat read.
    const pid = this.#readPidSafely();
    this.#lastPid = pid;

    if (staleMs < this.#opts.staleAfterMs) {
      // A daemon that answers has earned the whole restart budget back. Only a real
      // dead run should be able to exhaust it.
      this.#gaveUp = false;
      return {
        healthy: true,
        staleMs,
        restarts: this.#window.length,
        gaveUp: false,
        action: 'none',
        reason: `latido de hace ${formatDurationMs(staleMs)}`,
        pid,
      };
    }

    const silence =
      beat.source === 'missing'
        ? 'todavía no ha dado señales de vida'
        : `lleva ${formatDurationMs(staleMs)} sin responder`;

    if (this.#opts.statusOnly) {
      return {
        healthy: false,
        staleMs,
        restarts: this.#window.length,
        gaveUp: false,
        action: 'report',
        reason: `${silence} y estoy en modo consulta`,
        pid,
      };
    }

    if (this.#window.length >= this.#opts.maxRestarts) {
      this.#gaveUp = true;
      // Logged at error level because this is the outcome the human must see: a
      // crash-loop that keeps restarting is invisible, and invisible is the problem.
      log.error('watchdog gave up restarting', {
        restarts: this.#window.length,
        windowMs: this.#opts.windowMs,
        staleMs: Math.round(staleMs),
      });
      return {
        healthy: false,
        staleMs,
        restarts: this.#window.length,
        gaveUp: true,
        action: 'report',
        reason: `ya la reinicié ${plural(this.#window.length, 'vez', 'veces')} en ${formatDurationMs(this.#opts.windowMs)}`,
        pid,
      };
    }

    if (this.#opts.pidExpected && pid === null) {
      return {
        healthy: false,
        staleMs,
        restarts: this.#window.length,
        gaveUp: false,
        action: 'report',
        reason: 'no encuentro su proceso para cerrarlo',
        pid: null,
      };
    }

    this.#gaveUp = false;
    return {
      healthy: false,
      staleMs,
      restarts: this.#window.length,
      gaveUp: false,
      action: 'restart',
      reason: silence,
      pid,
    };
  }

  #readPidSafely(): number | null {
    try {
      return this.#opts.readPid();
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }

  /**
   * Drop restarts that have aged out of the window.
   *
   * This is what makes the budget a rate and not a lifetime cap: after a quiet stretch
   * the daemon can crash again and be restarted again, because the previous crash
   * happened too long ago to say anything about this one.
   */
  #prune(now: number): void {
    const cutoff = now - this.#opts.windowMs;
    // Un reinicio fechado por delante del reloj (hora corregida hacia atrás al volver
    // de suspender/hibernar) no caducaba hasta que el reloj lo alcanzara: con el cupo
    // lleno, el vigilante dejaba de reiniciar durante horas. Fuera también esos.
    this.#window = this.#window.filter((t) => t >= cutoff && t <= now + FUTURE_BEAT_TOLERANCE_MS);
  }

  stats(): WatchdogStats {
    const now = this.#opts.now();
    this.#prune(now);
    return {
      healthy: this.#lastStaleMs < this.#opts.staleAfterMs,
      staleMs: this.#lastStaleMs,
      staleAfterMs: this.#opts.staleAfterMs,
      lastHeartbeatAt:
        this.#lastHeartbeatAt === null ? null : new Date(this.#lastHeartbeatAt).toISOString(),
      lastHeartbeatSource: this.#lastSource,
      pid: this.#lastPid,
      restarts: this.#totalRestarts,
      restartsInWindow: this.#window.length,
      maxRestarts: this.#opts.maxRestarts,
      windowMs: this.#opts.windowMs,
      gaveUp: this.#gaveUp,
      lastAction: this.#lastAction,
      lastCheckAt: this.#lastCheckAt === null ? null : new Date(this.#lastCheckAt).toISOString(),
      lastError: this.#lastError,
      statusOnly: this.#opts.statusOnly,
    };
  }

  /** Forget the restart budget. Used after a manual fix, never automatically. */
  reset(): void {
    this.#window = [];
    this.#totalRestarts = 0;
    this.#gaveUp = false;
    this.#lastError = null;
    this.#lastAction = 'none';
  }

  /**
   * The report, as text. Pure: it never checks, never kills, never restarts.
   *
   * Spanish and written to be pasted into a chat, which is why it carries the concrete
   * numbers (how long, how many restarts) instead of "algo ha ido mal" — but no file
   * paths, pids or raw errors.
   */
  summary(verdict?: WatchdogVerdict): string {
    const now = this.#opts.now();
    const beat = readHeartbeat(this.#opts.heartbeatFile);
    const staleMs = this.#staleness(beat.at, now);
    const healthy = staleMs < this.#opts.staleAfterMs;
    const last = this.#safeLastTurn();
    const lines: string[] = [];

    if (healthy) {
      lines.push(
        `${this.#opts.daemonName} responde con normalidad: último latido hace ${formatDurationMs(staleMs)}.`,
      );
    } else {
      const silence =
        beat.source === 'missing'
          ? `${this.#opts.daemonName} todavía no ha dado señales de vida`
          : `${this.#opts.daemonName} lleva ${formatDurationMs(staleMs)} sin responder`;
      lines.push(`${silence}.`);
    }
    lines.push(`Lo último que hizo: ${last}.`);

    if (!healthy) {
      if (verdict?.gaveUp) {
        lines.push(
          `La he reiniciado ${plural(verdict.restarts, 'vez', 'veces')} en ${formatDurationMs(this.#opts.windowMs)} y sigue igual, así que dejo de reiniciarla: necesito que la mires tú (prueba «pa doctor»).`,
        );
      } else if (verdict?.action === 'restart') {
        lines.push(
          this.#opts.statusOnly
            ? 'Estoy en modo consulta, así que no la he tocado.'
            : 'La reinicio.',
        );
      } else if (verdict?.action === 'report') {
        lines.push(`${cap(verdict.reason)}, así que no toco nada.`);
      }
      // Ni la ruta del latido ni el error en crudo: eso va al registro, no al chat.
      if (this.#lastError) lines.push('Además, el vigilante tuvo un fallo al comprobarla.');
    }

    return lines.join('\n');
  }

  /**
   * Summary plus delivery. Returns the same text so a launcher can log or print it
   * when it has no channel of its own.
   */
  async report(verdict?: WatchdogVerdict): Promise<string> {
    const text = this.summary(verdict);
    log.warn('watchdog report', {
      healthy: verdict?.healthy ?? false,
      gaveUp: verdict?.gaveUp ?? false,
    });
    await this.#opts.onReport?.(text, verdict ?? this.#inspect());
    return text;
  }

  #safeLastTurn(): string {
    try {
      const value = this.#opts.lastTurn();
      const text = value?.trim();
      return text ? text : 'no lo sé';
    } catch {
      return 'no lo sé';
    }
  }
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface WatchdogLoopOptions extends WatchdogOptions {
  /** How often to look. Defaults to a tenth of the stale threshold. */
  intervalMs?: number;
  /** Stop after this many checks. `0` (the default) means until the signal aborts. */
  maxChecks?: number;
  onVerdict?: (verdict: WatchdogVerdict) => void | Promise<void>;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Poll until aborted. The launcher is then a one-liner.
 *
 * Reporting is deduped by *state* rather than by time: a watchdog that reports on
 * every poll turns a five-minute outage into two hundred Telegram messages, and the
 * human who has to read them is exactly the one this feature exists to help. So a
 * report goes out when the verdict changes into something worth saying — a restart, a
 * refusal to restart, a lost pid — and not again until it changes back.
 */
export async function runWatchdog(options: WatchdogLoopOptions): Promise<WatchdogVerdict[]> {
  const watchdog = new Watchdog(options);
  // 100ms floor rather than the derived default: the derived value is what keeps the
  // real thing sane, and a test or a one-shot launcher needs to be able to be fast.
  const interval = Math.max(100, options.intervalMs ?? Math.trunc(watchdog.staleAfterMs / 10));
  const max = options.maxChecks ?? 0;
  const verdicts: WatchdogVerdict[] = [];
  let reported = '';

  for (let i = 0; max <= 0 || i < max; i++) {
    if (options.signal?.aborted === true) break;
    const verdict = await watchdog.check();
    verdicts.push(verdict);
    await options.onVerdict?.(verdict);
    if (verdict.action === 'report') {
      const key = `${verdict.gaveUp ? 'gave-up' : verdict.reason}|${verdict.restarts}`;
      if (key !== reported) {
        reported = key;
        await watchdog.report(verdict);
      }
    } else {
      reported = '';
    }
    if (max <= 0 || i < max - 1) await sleep(interval, options.signal);
  }
  return verdicts;
}
