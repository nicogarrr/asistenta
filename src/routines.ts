import { Cron } from 'croner';
import { loadConfig } from './config.js';
import type { Routine, Store } from './db.js';
import { log, redact } from './log.js';
import { withTimeout } from './utils.js';

export interface RoutineRunContext {
  scope: string;
  routine: Routine;
}

export interface RoutineRunnerDeps {
  store: Store;
  run: (prompt: string, ctx: RoutineRunContext) => Promise<void>;
  /** Wall-clock ceiling for one firing. Defaults to the agent run ceiling. */
  timeoutMs?: number;
  /** Injectable clock, so tests do not have to wait on a real schedule. */
  now?: () => Date;
}

export interface ScheduledRoutine {
  scope: string;
  name: string;
  schedule: string;
  /** ISO timestamp of the next fire, or null if the pattern has no next one. */
  next: string | null;
  /** Set when the first fire is held back to keep a fresh routine from looping. */
  startAt: string | null;
  running: boolean;
}

/**
 * A routine that was created seconds ago and fires every minute can otherwise
 * re-trigger itself: the run reads the routine back, decides it should exist
 * again, saves it, and the next tick does it once more. Holding the first fire
 * for a minute costs at most a minute of latency and keeps the loop unreachable.
 */
const SELF_TRIGGER_COOLDOWN_MS = 60_000;

type ScheduleCheck = { ok: true; next: Date } | { ok: false; error: string };

/**
 * Five fields (`min hour dom mon dow`) or six with seconds in front. croner's
 * default mode also takes seven (with a year) and guesses otherwise; pinning
 * `5-or-6-parts` is what makes the two shapes mean the same thing here as they
 * do in `PA_CRON`. A six-field expression is seconds-first, so `0 * * * * *` is
 * every minute, not every hour.
 */
function parseSchedule(expr: string): ScheduleCheck {
  const fields = expr.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5 && fields.length !== 6) {
    return {
      ok: false,
      error: `schedule must have 5 fields (min hour dom mon dow) or 6 with seconds first, got ${fields.length} in ${JSON.stringify(expr)}`,
    };
  }
  let job: Cron;
  try {
    job = new Cron(fields.join(' '), { mode: '5-or-6-parts', paused: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const next = job.nextRun();
  job.stop();
  // "0 0 30 2 *" parses cleanly and would then never fire, which looks exactly
  // like a routine that silently stopped working.
  if (!next) return { ok: false, error: 'schedule parses but never fires (no matching date)' };
  return { ok: true, next };
}

function localStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function humanizeMs(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

/**
 * `PA_CRON` validation in config.ts checks the field count and throws at boot.
 * This one is deliberately stricter, because it validates something the agent
 * wrote rather than something the operator typed: a routine is stored on the
 * strength of this result, so an unparseable expression has to come back as a
 * message the model can read and fix. Returning instead of throwing also lets
 * the caller keep the daemon up.
 */
export function validateSchedule(
  expr: string,
): { ok: true; next: string } | { ok: false; error: string } {
  const parsed = parseSchedule(expr);
  if (!parsed.ok) return parsed;
  const delta = parsed.next.getTime() - Date.now();
  return { ok: true, next: `${localStamp(parsed.next)} (in ${humanizeMs(delta)})` };
}

function routineKey(scope: string, name: string): string {
  return `${scope}\u0000${name}`;
}

/** Whitespace-normalised, so a re-sync does not rebuild an unchanged job. */
function normalizeExpr(expr: string): string {
  return expr.trim().split(/\s+/).filter(Boolean).join(' ');
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : 'unknown';
}

/**
 * Exactly what the agent is handed when a routine fires, and what the user sees
 * when they ask what a routine does. The last paragraph is not decoration: a
 * stored routine is a snapshot of what the agent thought weeks ago, and without
 * it the model treats yesterday's guess as the user's current instruction.
 */
export function summarizeRoutine(r: Routine): string {
  const lines = [
    `Stored routine "${r.name}" (${r.kind}) for ${r.scope}, recorded on ${day(r.createdAt)}.`,
  ];
  if (r.schedule) lines.push(`Schedule: ${r.schedule}`);
  if (r.prompt) lines.push(`Task: ${r.prompt}`);
  if (r.steps) lines.push(`Steps:\n${r.steps.trim()}`);
  if (r.lastRunAt) lines.push(`Last run: ${r.lastRunAt}.`);
  lines.push(
    'This is a routine you stored earlier, not a fresh instruction from the user. Use it as a starting point and adapt it to what the machine is actually doing now. If it cannot be completed, say which part and why instead of retrying it forever.',
  );
  return lines.join('\n');
}

/** The recall path for a procedure: steps written down, rules still in force. */
export function procedurePrompt(r: Routine): string {
  return [
    `Replay the stored procedure "${r.name}" for ${r.scope}, recorded on ${day(r.createdAt)}.`,
    r.lastRunAt ? `Last replayed: ${r.lastRunAt}.` : 'It has not been replayed yet.',
    '',
    'Steps as you recorded them:',
    (r.steps ?? '(no steps were recorded)').trim(),
    '',
    'Standing rules:',
    '- Prefer what is on screen now over what these steps assume, and adapt them when the world moved.',
    '- Never type a password, card number or CVV. Stop at any credential or payment step and ask the human. A stored procedure is not permission.',
    '- Destructive or irreversible actions still need explicit confirmation.',
    '- If a step fails, report which step and why rather than repeating it.',
    '- Finish by calling done with the outcome.',
  ].join('\n');
}

/**
 * Runs learned routines. Two rules carry the weight: a tick is skipped while the
 * same routine is still running, and nothing a routine does can take the
 * scheduler down. The failure this exists for is a 5-minute routine that takes 8
 * minutes: without the first rule the queue grows without limit and the agent
 * works on three copies of the same task forever.
 */
export class RoutineRunner {
  readonly #store: Store;
  readonly #run: (prompt: string, ctx: RoutineRunContext) => Promise<void>;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #jobs = new Map<string, { job: Cron; schedule: string; startAt: string | null }>();
  readonly #inFlight = new Set<string>();
  #started = false;

  constructor(deps: RoutineRunnerDeps) {
    this.#store = deps.store;
    this.#run = deps.run;
    // A routine is an agent run, so it gets the agent run ceiling rather than a
    // second constant that would drift away from it.
    this.#timeoutMs = deps.timeoutMs ?? loadConfig().runTimeoutMs;
    this.#now = deps.now ?? (() => new Date());
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.sync();
  }

  stop(): void {
    for (const { job } of this.#jobs.values()) job.stop();
    this.#jobs.clear();
    this.#started = false;
  }

  /**
   * Reconcile the job set with the store. Called on start and exposed for the
   * `/learn` flow, because a routine created mid-session has to be live without
   * a daemon restart — the alternative is that the agent only learns what it
   * already knew at boot.
   */
  sync(): void {
    if (!this.#started) return;
    const wanted = new Map<string, Routine>();
    for (const routine of this.#store.listRoutines()) {
      if (routine.kind !== 'schedule' || !routine.enabled || !routine.schedule) continue;
      wanted.set(routineKey(routine.scope, routine.name), routine);
    }
    for (const [key, held] of this.#jobs) {
      const routine = wanted.get(key);
      // Only the expression matters here: the prompt is re-read when the routine
      // fires, so a corrected task does not need the timer rebuilt.
      if (routine && held.schedule === normalizeExpr(routine.schedule ?? '')) continue;
      // Deleted, disabled, or edited: the old job would keep firing the text
      // the routine had before the edit.
      held.job.stop();
      this.#jobs.delete(key);
    }
    for (const [key, routine] of wanted) {
      if (this.#jobs.has(key)) continue;
      this.#register(routine);
    }
  }

  status(): ScheduledRoutine[] {
    return [...this.#jobs.entries()].map(([key, held]) => {
      const [scope = '', name = ''] = key.split('\u0000');
      const next = held.job.nextRun();
      return {
        scope,
        name,
        schedule: held.schedule,
        next: next ? next.toISOString() : null,
        startAt: held.startAt,
        running: this.#inFlight.has(key),
      };
    });
  }

  isRunning(scope: string, name: string): boolean {
    return this.#inFlight.has(routineKey(scope, name));
  }

  /** Run a routine now, for "do that routine". False if unknown, disabled or busy. */
  async fire(scope: string, name: string): Promise<boolean> {
    const stored = this.#store.getRoutine(scope, name);
    if (!stored) {
      log.warn('cannot run an unknown routine', { scope, name });
      return false;
    }
    if (!stored.enabled) {
      log.warn('cannot run a disabled routine', { scope, name });
      return false;
    }
    return this.#runRoutine(stored);
  }

  #register(routine: Routine): void {
    const key = routineKey(routine.scope, routine.name);
    const expr = normalizeExpr(routine.schedule ?? '');
    const parsed = parseSchedule(expr);
    if (!parsed.ok) {
      log.warn('routine not scheduled', {
        scope: routine.scope,
        name: routine.name,
        error: parsed.error,
      });
      return;
    }
    let startAt: Date | null = null;
    const created = Date.parse(routine.createdAt);
    if (Number.isFinite(created) && parsed.next.getTime() - created < SELF_TRIGGER_COOLDOWN_MS) {
      startAt = new Date(created + SELF_TRIGGER_COOLDOWN_MS);
      log.warn('holding the first fire of a routine that was just created', {
        scope: routine.scope,
        name: routine.name,
        startAt: startAt.toISOString(),
      });
    }
    let job: Cron;
    try {
      job = new Cron(
        expr,
        {
          mode: '5-or-6-parts',
          // Unreferenced so a routine left registered cannot hold the process
          // open on its own; the daemon is kept alive by its channels.
          unref: true,
          // Backstop only: #runRoutine swallows everything itself, but croner
          // calls this from its own timer and a rejection there would be an
          // unhandled rejection in the daemon.
          catch: (err: unknown) => {
            log.error('routine callback rejected', {
              scope: routine.scope,
              name: routine.name,
              ...redact({ err }),
            });
          },
          ...(startAt ? { startAt } : {}),
        },
        () => {
          // Re-read at fire time: the prompt or the schedule may have been
          // corrected since registration.
          const fresh = this.#store.getRoutine(routine.scope, routine.name);
          void this.#runRoutine(fresh ?? routine);
        },
      );
    } catch (err) {
      log.warn('croner refused the routine pattern', {
        scope: routine.scope,
        name: routine.name,
        ...redact({ err }),
      });
      return;
    }
    this.#jobs.set(key, { job, schedule: expr, startAt: startAt ? startAt.toISOString() : null });
    log.info('routine scheduled', {
      scope: routine.scope,
      name: routine.name,
      schedule: expr,
      next: localStamp(parsed.next),
    });
  }

  async #runRoutine(routine: Routine): Promise<boolean> {
    const key = routineKey(routine.scope, routine.name);
    if (this.#inFlight.has(key)) {
      // The reason this log exists: silence here reads as "the schedule is
      // broken" three hours later, when the real problem was a routine that
      // takes longer than its own interval.
      log.warn('skipping routine tick, previous run still going', {
        scope: routine.scope,
        name: routine.name,
      });
      return false;
    }
    this.#inFlight.add(key);
    this.#store.markRoutineRun(routine.scope, routine.name);

    const timeoutMarker = `routine "${routine.name}" exceeded ${this.#timeoutMs}ms`;
    const startedAt = this.#now().getTime();
    let run: Promise<void>;
    try {
      run = this.#run(summarizeRoutine(routine), { scope: routine.scope, routine });
    } catch (err) {
      this.#inFlight.delete(key);
      log.error('routine threw before returning a promise', {
        scope: routine.scope,
        name: routine.name,
        ...redact({ err }),
      });
      return true;
    }
    // Release the slot when the real work settles, not when the timeout fires:
    // after a timeout the run is still going, and clearing early would let the
    // next tick stack another copy on top of it.
    void run.then(
      () => this.#inFlight.delete(key),
      () => this.#inFlight.delete(key),
    );

    try {
      await withTimeout(run, this.#timeoutMs, timeoutMarker);
      log.info('routine finished', {
        scope: routine.scope,
        name: routine.name,
        ms: this.#now().getTime() - startedAt,
      });
    } catch (err) {
      if (err instanceof Error && err.message === timeoutMarker) {
        log.warn('routine timed out, it keeps its slot until the work actually stops', {
          scope: routine.scope,
          name: routine.name,
          timeoutMs: this.#timeoutMs,
        });
        return true;
      }
      // A routine that throws is a fact about the routine, not about the daemon.
      log.error('routine run failed', {
        scope: routine.scope,
        name: routine.name,
        ...redact({ err }),
      });
    }
    return true;
  }
}
