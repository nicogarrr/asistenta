/**
 * The goal tick: one scheduled firing of a long-haul goal.
 *
 * A goal rides the RoutineRunner as a routine named `objetivo:<id>`, so the
 * cron engine, the /agenda visibility and the one-at-a-time firing discipline
 * are inherited, not rebuilt. What is NOT inherited is the delivery: an
 * ordinary routine telegram-sends its prompt, while a goal tick EXECUTES an
 * agent run (injected as `execute`, wired in cli.ts onto the owning thread's
 * serialized tail with its gate live) and stays silent unless the outcome is
 * a novelty or a decision.
 *
 * The outcome contract lives in the tick prompt: the agent ends with `done`
 * whose summary starts with one tag - [progreso] [hito] [bloqueo] [decision]
 * [hecho]. A missing or unknown tag is treated as notifiable ("si dudas entre
 * escalar o seguir, escala"), which fails loud instead of swallowing the one
 * update Nico needed.
 *
 * This class never throws: a goal tick cannot be what takes the scheduler down.
 */
import { localDay } from '../datecontext.js';
import type { Routine, Store } from '../db.js';
import { log } from '../log.js';
import type { GoalNotifier } from './notify.js';
import { type GoalWorkstreamProjection, projectGoal } from './projection.js';
import type { Goal, GoalStore } from './store.js';

export const GOAL_ROUTINE_PREFIX = 'objetivo:';

export const goalRoutineName = (id: string): string => `${GOAL_ROUTINE_PREFIX}${id}`;

export function isGoalRoutine(r: Pick<Routine, 'name'>): boolean {
  return r.name.startsWith(GOAL_ROUTINE_PREFIX);
}

export function goalIdOf(name: string): string | null {
  if (!name.startsWith(GOAL_ROUTINE_PREFIX)) return null;
  const id = name.slice(GOAL_ROUTINE_PREFIX.length).trim();
  return id || null;
}

export type GoalOutcomeKind =
  | 'progreso'
  | 'hito'
  | 'bloqueo'
  | 'decision'
  | 'hecho'
  | 'desconocido';

const TAG = /^\[(progreso|hito|bloqueo|decision|decisión|hecho)\]\s*/i;

/** Reads the outcome tag off the tick's done summary. */
export function parseOutcome(text: string): { kind: GoalOutcomeKind; reason: string } {
  const trimmed = text.trim();
  const m = TAG.exec(trimmed);
  if (!m) return { kind: 'desconocido', reason: trimmed.slice(0, 600) || '(sin resumen)' };
  const kind = (m[1] ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') as GoalOutcomeKind;
  return { kind, reason: trimmed.slice(m[0].length).trim() || '(sin detalle)' };
}

/**
 * The tick prompt, in Spanish: the outcome tags are user-meaningful and the
 * agent's done summary is what Nico reads on a notification.
 */
export function buildTickPrompt(goal: Goal): string {
  const steps = goal.plan
    .map((s, i) => `  ${i + 1}. [${s.done ? 'x' : ' '}] ${s.text}${s.note ? ` — ${s.note}` : ''}`)
    .join('\n');
  const pending = goal.plan.filter((s) => !s.done).length;
  const lines = [
    `Estás trabajando en el objetivo a largo plazo "${goal.title}". Este es un tick programado: no hay mensaje nuevo de Nico.`,
    '',
    `Objetivo literal de Nico: ${goal.verbatim}`,
    '',
    'Plan aprobado:',
    steps || '  (sin pasos)',
    '',
    `Último resultado: ${goal.lastOutcome ?? '(primer tick)'}.`,
  ];
  if (goal.blockedReason) {
    // Resuming after a decision/block: Nico's answer is in the recent chat context.
    lines.push(
      `Esto estaba pendiente: ${goal.blockedReason}. Si Nico ya respondió en el chat, continúa con su respuesta.`,
    );
  }
  lines.push(
    '',
    'Reglas:',
    `- Ejecuta el siguiente paso pendiente del plan (quedan ${pending}). No rehagas pasos marcados.`,
    '- Registra el avance con la herramienta objetivo (action=avance) cuando completes un paso.',
    '- Dinero, credenciales, escribir a terceros o acciones destructivas: el Gate le pregunta a Nico. Si dudas entre escalar o seguir, escala.',
    '- Silencio si no hay nada que contar: Nico solo oye novedades y decisiones.',
    '- Termina llamando a done con un resumen que EMPIECE por una etiqueta exacta:',
    '  [progreso] avancé pero no hay nada que contar',
    '  [hito] completé un paso del plan o cambió algo que le importa',
    '  [bloqueo] no puedo seguir sin él (qué falta y por qué)',
    '  [decision] necesito que Nico elija (la pregunta concreta, con opciones)',
    '  [hecho] objetivo cumplido (resumen de qué quedó hecho)',
  );
  return lines.join('\n');
}

export interface GoalTickResult {
  text: string;
  error: string | null;
}

export interface GoalRunnerDeps {
  goals: GoalStore;
  notifier: GoalNotifier;
  store: Pick<Store, 'getRoutine' | 'deleteRoutine' | 'listRoutines'>;
  /** RoutineRunner.sync, so a finished goal's routine disappears live. */
  sync: () => void;
  /** Runs the tick prompt on the owning thread (gate live, tail serialized). Wired in cli.ts. */
  execute: (goal: Goal, prompt: string) => Promise<GoalTickResult>;
  /** Local day key (YYYY-MM-DD) for the per-day tick budget. */
  dayKey?: () => string;
  /** Hook for the workstream projection when a goal completes. */
  onDone?: (goal: Goal) => void;
  /** Optional memory view; updates only after the durable goal transition. */
  workstreams?: GoalWorkstreamProjection;
}

export class GoalRunner {
  readonly #deps: GoalRunnerDeps;
  readonly #dayKey: () => string;

  constructor(deps: GoalRunnerDeps) {
    this.#deps = deps;
    this.#dayKey = deps.dayKey ?? (() => localDay());
  }

  /** Entry point from the RoutineRunner firing. Never throws. */
  async tickByRoutineName(name: string): Promise<void> {
    try {
      await this.#tick(name);
    } catch (err) {
      log.error('goal tick threw', { routine: name, err });
    }
  }

  #deleteRoutine(scope: string, name: string): void {
    if (this.#deps.store.getRoutine(scope, name)) {
      this.#deps.store.deleteRoutine(scope, name);
      this.#deps.sync();
    }
  }

  async #tick(name: string): Promise<void> {
    const id = goalIdOf(name);
    if (!id) return;
    let goal = this.#deps.goals.read(id);
    if (!goal) {
      // Self-cleaning: a routine that outlived its goal goes away instead of
      // firing forever (the goal was deleted while the runner was down).
      const routine = this.#deps.store.listRoutines().find((r) => r.name === name);
      if (routine) {
        this.#deps.store.deleteRoutine(routine.scope, name);
        this.#deps.sync();
      }
      return;
    }

    // Delivery is independent of execution eligibility. A pending question or
    // closing note is retried on EVERY firing - while the goal is paused,
    // blocked on a decision, already done or out of daily budget - because
    // those are exactly the messages Nico cannot afford to lose. Rows live in
    // SQLite, so retries survive restarts; the notifier drops them after 24h;
    // and flushing never runs work, so a finished goal stays finished.
    await this.#deps.notifier.flush(goal).catch(() => {});

    // Delivery can await network I/O. A pause/cancellation during that await
    // wins over the snapshot taken before it; never launch work from stale state.
    goal = this.#deps.goals.read(id);
    if (!goal) return;

    if (goal.status === 'cancelled') {
      this.#deleteRoutine(goal.scope, name);
      return;
    }
    if (goal.status === 'done') {
      // A finished goal keeps its routine only while its closing note is still
      // undelivered; once delivered - or dropped by the 24h rule - the routine
      // cleans itself up.
      if (!this.#deps.notifier.hasPending(goal.id)) {
        this.#deleteRoutine(goal.scope, name);
      }
      return;
    }
    // proposed waits for its human yes; paused/blocked wait for Nico. Silent skips.
    if (goal.status !== 'active') return;
    const day = this.#dayKey();
    if (!this.#deps.goals.tickAllowed(goal, day)) {
      log.warn('goal tick budget exhausted for today', { goal: goal.id });
      return;
    }

    let result: GoalTickResult;
    try {
      result = await this.#deps.execute(goal, buildTickPrompt(goal));
    } catch (err) {
      result = { text: '', error: err instanceof Error ? err.message : String(err) };
    }
    // No markRoutineRun here: the RoutineRunner already records this firing
    // when it starts it (routines.ts #runRoutine). A second write after the
    // run moved last_run_at to the END of a long tick - every goal tick was
    // recorded twice, and the catch-up's "last ran" read the later time.

    // Execution also yields. A late result must not mark a cancelled/paused
    // goal done (or emit a false closing note). Count the work that did run,
    // but leave the newer lifecycle decision and its projection untouched.
    const current = this.#deps.goals.read(goal.id);
    if (!current) return;
    if (current.status !== 'active') {
      this.#deps.goals.noteTick(goal.id, 'interrupted', day);
      return;
    }

    if (result.error) {
      this.#deps.goals.noteTick(goal.id, 'error', day);
      await this.#deps.notifier.report(goal, 'error', result.error);
      return;
    }

    const outcome = parseOutcome(result.text);
    this.#deps.goals.noteTick(goal.id, outcome.kind, day);
    switch (outcome.kind) {
      case 'progreso':
        // Silence: the whole point of the contract.
        return;
      case 'hito':
        await this.#deps.notifier.report(goal, 'hito', outcome.reason);
        return;
      case 'bloqueo':
        this.#deps.goals.block(goal.id, outcome.reason);
        if (this.#deps.workstreams)
          projectGoal(this.#deps.goals.read(goal.id) ?? goal, this.#deps.workstreams);
        await this.#deps.notifier.report(goal, 'bloqueo', outcome.reason);
        return;
      case 'decision':
        this.#deps.goals.block(goal.id, `Decisión pendiente: ${outcome.reason}`);
        if (this.#deps.workstreams)
          projectGoal(this.#deps.goals.read(goal.id) ?? goal, this.#deps.workstreams);
        await this.#deps.notifier.report(goal, 'decision', outcome.reason);
        return;
      case 'hecho': {
        this.#deps.goals.complete(goal.id);
        await this.#deps.notifier.report(goal, 'hecho', outcome.reason);
        // The routine survives an undelivered closing note: the next firing
        // lands on the done branch above, flushes, and only then self-cleans.
        if (!this.#deps.notifier.hasPending(goal.id)) {
          this.#deleteRoutine(goal.scope, name);
        }
        this.#deps.onDone?.(goal);
        return;
      }
      default:
        // desconocido: notify rather than swallow.
        await this.#deps.notifier.report(goal, 'desconocido', outcome.reason);
    }
  }
}
