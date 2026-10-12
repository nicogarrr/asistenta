/**
 * The `objetivo` tool: Nico states a long-haul goal in natural language and
 * the daemon works on it for days (capability 4).
 *
 * Lifecycle: proponer shows the plan (Spanish, one Telegram-legible piece) and
 * waits; activar starts the ticks - and only ever through the Gate, which
 * hardcodes `objetivo:activar` as always-ask, the same treatment as a factory
 * install: days of autonomous work need a human yes, every time, never a memo.
 * pausar/reanudar/cancelar manage it afterwards; avance is how a tick records
 * progress on the approved plan.
 *
 * The scope comes from the caller, never from the model: a goal acts on the
 * chat that owns it and its notifications go there and nowhere else.
 */
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Cron } from 'croner';
import { Type } from 'typebox';
import type { Store } from '../db.js';
import { goalRoutineName } from '../goals/runner.js';
import { type Goal, type GoalStore, MAX_ACTIVE_GOALS, MAX_PROPOSED_GOALS } from '../goals/store.js';

/** Two ticks of one goal never land closer than this: autonomy, not a spin loop. */
export const MIN_GOAL_TICK_MS = 60 * 60_000;

const Params = Type.Object({
  action: Type.Union([
    Type.Literal('proponer'),
    Type.Literal('activar'),
    Type.Literal('pausar'),
    Type.Literal('reanudar'),
    Type.Literal('cancelar'),
    Type.Literal('listar'),
    Type.Literal('estado'),
    Type.Literal('avance'),
  ]),
  id: Type.Optional(
    Type.String({
      description: 'Goal id (from proponer/listar). All actions but proponer/listar.',
    }),
  ),
  titulo: Type.Optional(Type.String({ description: 'proponer: short title, in Spanish.' })),
  objetivo: Type.Optional(
    Type.String({ description: "proponer: the user's objective, verbatim." }),
  ),
  pasos: Type.Optional(
    Type.Array(Type.String(), { description: 'proponer: the plan, one step per entry, in order.' }),
  ),
  cadencia: Type.Optional(
    Type.String({
      description:
        'proponer: 5-field local cron for the ticks (min hour dom mon dow), at most once an hour, e.g. "20 * * * *".',
    }),
  ),
  paso: Type.Optional(Type.Number({ description: 'avance: 1-based step number completed.' })),
  nota: Type.Optional(
    Type.String({ description: 'avance: one line on what happened in that step.' }),
  ),
});

function reply(text: string, isError = false): AgentToolResult {
  return { content: [{ type: 'text', text }], details: {}, isError };
}

/** Same rule as repeating reminders: 5 fields, and never closer than an hour apart. */
export function checkCadence(expr: string): string | null {
  const fields = expr.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    return 'La cadencia usa 5 campos (min hora día mes díaSemana), sin segundos.';
  }
  let runs: Date[];
  try {
    runs = new Cron(fields.join(' '), { paused: true }).nextRuns(8);
  } catch {
    return `La cadencia "${expr}" no es un cron válido.`;
  }
  for (let i = 1; i < runs.length; i++) {
    const gap = (runs[i]?.getTime() ?? 0) - (runs[i - 1]?.getTime() ?? 0);
    if (gap < MIN_GOAL_TICK_MS) {
      return 'Un objetivo no puede tener ticks más de una vez por hora.';
    }
  }
  return null;
}

/** The plan Nico approves: Spanish, one piece, no JSON. */
export function formatProposal(goal: Goal): string {
  const steps = goal.plan.map((s, i) => `${i + 1}. ${s.text}`).join('\n');
  return [
    `🎯 Objetivo propuesto: "${goal.title}"`,
    '',
    `Lo que pediste: ${goal.verbatim}`,
    '',
    'Plan:',
    steps,
    '',
    `Cadencia de trabajo: cada tick según "${goal.cadence}" (hora local), nunca más de uno por hora, máximo 12 al día.`,
    'Te aviso solo cuando haya una novedad o una decisión tuya. Dinero, credenciales, terceros y acciones destructivas te preguntan siempre.',
    '',
    `Para activarlo responde "sí". Para cambiar algo, dime qué. (id: ${goal.id})`,
  ].join('\n');
}

const STATUS_LABEL: Record<Goal['status'], string> = {
  proposed: 'propuesto (esperando tu sí)',
  active: 'activo',
  paused: 'pausado',
  blocked: 'bloqueado (esperándote)',
  done: 'cumplido',
  cancelled: 'cancelado',
};

function oneLine(goal: Goal): string {
  const done = goal.plan.filter((s) => s.done).length;
  return `- "${goal.title}" [${STATUS_LABEL[goal.status]}] ${done}/${goal.plan.length} pasos (id: ${goal.id})`;
}

export interface GoalToolDeps {
  goals: GoalStore;
  scopeOf: () => string;
  store: Pick<Store, 'saveRoutine' | 'deleteRoutine'>;
  /** RoutineRunner.sync: a created/paused/resumed/cancelled goal goes live without a daemon restart. */
  sync: () => void;
  /** The prompt projection every other conversation sees. */
  workstreams: {
    create(scope: string, title: string, goal: string): string;
    update(id: string, fields: { status?: 'done'; nextSteps?: string | null }): void;
    forget(id: string): void;
  };
}

export function createGoalTool(deps: GoalToolDeps): AgentTool<typeof Params> {
  /** Reads the goal and pins it to the calling chat: no cross-chat reach. */
  const mine = (id: string | undefined): Goal | AgentToolResult => {
    if (!id) return reply('Falta el id del objetivo (lo ves con action=listar).', true);
    const goal = deps.goals.read(id);
    if (!goal) return reply(`No existe el objetivo ${id}.`, true);
    if (goal.scope !== deps.scopeOf()) {
      return reply('Ese objetivo pertenece a otro chat; aquí no puedes tocarlo.', true);
    }
    return goal;
  };

  const setRoutineEnabled = (goal: Goal, enabled: boolean): void => {
    deps.store.saveRoutine({
      scope: goal.scope,
      name: goalRoutineName(goal.id),
      kind: 'schedule',
      prompt: `objetivo: ${goal.title}`,
      schedule: goal.cadence,
      enabled,
    });
    deps.sync();
  };

  return {
    name: 'objetivo',
    label: 'Objetivo',
    description: [
      'Long-haul goals: the user states ONE objective and you work on it for days in scheduled ticks.',
      'proponer: build the plan and show it (the user must say yes before anything runs).',
      'activar: start the ticks - ONLY after the user said an explicit yes to the plan just shown; the gate still asks them.',
      'avance: mark a plan step done. pausar/reanudar/cancelar/listar/estado manage the goal.',
      'Never claim a goal is active unless activar said so.',
    ].join('\n'),
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const scope = deps.scopeOf();

      if (args.action === 'proponer') {
        if (!args.titulo?.trim() || !args.objetivo?.trim()) {
          return reply('proponer necesita titulo y objetivo (las palabras del usuario).', true);
        }
        const pasos = (args.pasos ?? []).map((p) => p.trim()).filter(Boolean);
        if (pasos.length === 0)
          return reply('proponer necesita al menos un paso en el plan.', true);
        if (!args.cadencia) return reply('proponer necesita la cadencia (cron de 5 campos).', true);
        const bad = checkCadence(args.cadencia);
        if (bad) return reply(bad, true);
        const goal = deps.goals.propose({
          scope,
          title: args.titulo.trim().slice(0, 120),
          verbatim: args.objetivo.trim().slice(0, 1000),
          plan: pasos.slice(0, 20).map((text) => ({ text: text.slice(0, 200), done: false })),
          cadence: args.cadencia.trim(),
        });
        return reply(formatProposal(goal));
      }

      if (args.action === 'listar') {
        const rows = deps.goals
          .list(scope)
          .filter((g) => g.status !== 'done' && g.status !== 'cancelled');
        if (rows.length === 0) return reply('No hay objetivos en marcha ni propuestos.');
        return reply(['Objetivos:', ...rows.map(oneLine)].join('\n'));
      }

      const goalOrErr = mine(args.id);
      if (!('plan' in goalOrErr)) return goalOrErr;
      const goal = goalOrErr;

      switch (args.action) {
        case 'estado': {
          const steps = goal.plan
            .map(
              (s, i) =>
                `  ${i + 1}. [${s.done ? 'x' : ' '}] ${s.text}${s.note ? ` — ${s.note}` : ''}`,
            )
            .join('\n');
          return reply(
            [
              `🎯 "${goal.title}" [${STATUS_LABEL[goal.status]}]`,
              `Último resultado: ${goal.lastOutcome ?? '(aún ninguno)'}.`,
              goal.blockedReason ? `Pendiente: ${goal.blockedReason}` : '',
              `Ticks hoy: ${goal.ticksToday}/12.`,
              'Plan:',
              steps,
            ]
              .filter(Boolean)
              .join('\n'),
          );
        }
        case 'activar': {
          const wsId = deps.workstreams.create(scope, goal.title, goal.verbatim);
          deps.goals.activate(goal.id, wsId);
          setRoutineEnabled(goal, true);
          return reply(
            `Objetivo "${goal.title}" activado. Trabajaré en ticks (${goal.cadence}, hora local) y te aviso solo con novedades o decisiones.`,
          );
        }
        case 'pausar': {
          deps.goals.pause(goal.id);
          setRoutineEnabled(goal, false);
          return reply(`Objetivo "${goal.title}" pausado. No habrá ticks hasta que lo reanudes.`);
        }
        case 'reanudar': {
          deps.goals.resume(goal.id);
          setRoutineEnabled(goal, true);
          return reply(
            `Objetivo "${goal.title}" reanudado.${goal.blockedReason ? '' : ''} En el próximo tick sigo con el contexto de este chat.`,
          );
        }
        case 'cancelar': {
          deps.goals.cancel(goal.id);
          deps.store.deleteRoutine(goal.scope, goalRoutineName(goal.id));
          deps.sync();
          if (goal.workstreamId) {
            try {
              deps.workstreams.forget(goal.workstreamId);
            } catch {
              /* a workstream already forgotten is fine */
            }
          }
          return reply(`Objetivo "${goal.title}" cancelado. Ya no habrá más ticks.`);
        }
        case 'avance': {
          const idx = (args.paso ?? 0) - 1;
          if (idx < 0 || idx >= goal.plan.length) {
            return reply(`paso debe ser un número entre 1 y ${goal.plan.length}.`, true);
          }
          const plan = goal.plan.map((s, i) =>
            i === idx ? { ...s, done: true, note: args.nota?.slice(0, 200) || s.note } : s,
          );
          deps.goals.updatePlan(goal.id, plan);
          if (goal.workstreamId) {
            const next = plan.find((s) => !s.done);
            try {
              deps.workstreams.update(goal.workstreamId, {
                nextSteps: next ? next.text : 'plan completado',
              });
            } catch {
              /* projection lag is not worth failing the tick */
            }
          }
          return reply(`Paso ${idx + 1} de "${goal.title}" marcado como hecho.`);
        }
        default:
          return reply(`Acción no soportada: ${args.action as string}`, true);
      }
    },
  };
}

export { MAX_ACTIVE_GOALS, MAX_PROPOSED_GOALS };
