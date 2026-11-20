import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Cron } from 'croner';
import { isCommandRoutine } from '../command-routine.js';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { horarioEnLista, horarioRutinaEs, programadaRutinaEs } from '../cron/cadencia.js';
import { parseCronAdd } from '../cron/scheduler.js';
import { formatNextRun, routineNameFromPrompt, uniqueRoutineName } from '../daemon/cron-command.js';
import { localTimeZone } from '../datecontext.js';
import type { Routine, Store } from '../db.js';
import { isGoalRoutine } from '../goals/runner.js';
import { nextScheduleRun, validateSchedule } from '../routines.js';
import { foldAccents } from '../text.js';
import { isReminder } from './reminder.js';

/**
 * Rutinas programadas desde la conversación: «cada lunes a las 9 revisa el gasto y
 * me avisas». A su hora la rutina ejecuta la tarea CON el modelo (mismas
 * herramientas y aprobaciones que un turno) y el resultado llega a este chat
 * (routine-delivery, destino `chat` por defecto) — el «te aviso aquí».
 *
 * No es un recordatorio: un recordatorio AVISA al dueño para que haga él algo;
 * una rutina lo HACE Asistenta y avisa con el resultado. Las rutinas viven en el
 * mismo registro que las de /cron add (kind 'schedule' con prompt), así que se
 * ven y se gestionan también con /cron, /rutinas y la agenda.
 *
 * Límites: como cada ejecución habla con el modelo, una rutina no puede sonar más
 * de una vez por hora ni acumularse sin tope en un chat.
 */

/** Cada disparo usa el modelo: más seguido que esto es gasto (y ruido), no utilidad. */
export const MIN_ROUTINE_GAP_MS = 60 * 60_000;
/** Tope de rutinas de agente por chat (sin contar recordatorios, avisos ni objetivos). */
export const MAX_AGENT_ROUTINES_PER_CHAT = 20;
const MAX_TASK = 300;

const Params = lazySchema(() =>
  Type.Object({
    action: Type.Union([
      Type.Literal('create'),
      Type.Literal('list'),
      Type.Literal('pause'),
      Type.Literal('resume'),
      Type.Literal('cancel'),
    ]),
    said: Type.Optional(
      Type.String({
        description:
          "create: the whole thing in the user's words, verbatim («cada lunes a las 9 revisar el gasto»; also «0 9 * * 1 | revisar el gasto»). pause/resume/cancel: a word from the routine name or task.",
      }),
    ),
  }),
);

function reply(text: string, isError = false): AgentToolResult {
  return { content: [{ type: 'text', text }], details: {}, isError };
}

/** Las rutinas de agente del chat: ni recordatorios, ni avisos de herramientas, ni objetivos. */
function isAgentRoutine(r: Routine): boolean {
  return r.kind === 'schedule' && !isReminder(r) && !isCommandRoutine(r) && !isGoalRoutine(r);
}

/** Rechaza horarios que dispararían el modelo más de una vez por hora. */
export function checkRoutineFrequency(expr: string): string | null {
  const runs = new Cron(expr.trim(), { paused: true, timezone: localTimeZone() }).nextRuns(8);
  for (let i = 1; i < runs.length; i++) {
    const gap = (runs[i]?.getTime() ?? 0) - (runs[i - 1]?.getTime() ?? 0);
    if (gap < MIN_ROUTINE_GAP_MS) {
      return 'Una rutina no puede ejecutarse más de una vez por hora (cada ejecución habla con el modelo). Ponle más espacio.';
    }
  }
  return null;
}

export interface RoutineToolDeps {
  store: Pick<Store, 'saveRoutine' | 'deleteRoutine' | 'getRoutine' | 'listRoutines'>;
  scopeOf: () => string;
  /** RoutineRunner.sync: la rutina creada o tocada entra en marcha sin reiniciar. */
  sync: () => void;
  /** Próxima ejecución real (el runner sabe de primeras veces retenidas y festivos). */
  nextOf?: (r: Routine) => Date | null;
  now?: () => number;
}

export function createRoutineTool(deps: RoutineToolDeps): AgentTool<ReturnType<typeof Params>> {
  const now = deps.now ?? (() => Date.now());
  const nextOf = deps.nextOf ?? ((r: Routine) => (r.schedule ? nextScheduleRun(r.schedule) : null));
  const mine = (scope: string) => deps.store.listRoutines(scope).filter(isAgentRoutine);

  /** Una rutina del chat por una palabra de su nombre o tarea; la exacta manda. */
  const find = (scope: string, needle: string): Routine[] => {
    const want = foldAccents(needle).trim();
    const hits = mine(scope).filter((r) =>
      foldAccents(`${r.name} ${r.prompt ?? ''}`).includes(want),
    );
    const exact = hits.filter((r) => foldAccents(r.name).trim() === want);
    return exact.length === 1 ? exact : hits;
  };

  const listLine = (r: Routine): string => {
    const next = nextOf(r);
    return `- ${r.name} [${horarioEnLista(r)}] — ${
      r.enabled
        ? `próxima: ${next ? formatNextRun(next.getTime(), now()) : 'sin próxima vez'}`
        : 'EN PAUSA'
    }: ${r.prompt ?? ''}`;
  };

  return {
    name: 'rutina',
    label: 'Rutina programada',
    description: [
      'Scheduled routines: a task YOU do on a repeating schedule, reporting the result to this chat («every Monday at 9 review my spending and tell me», «cada mañana a las 8 el resumen del día»).',
      "action=create with said: the whole thing in the user's words, verbatim. The schedule must repeat (every day, every Monday...); for a one-time nudge or a «remind me to…» use reminder instead.",
      "action=list shows this chat's routines. pause/resume/cancel take a word from the routine name or task.",
      'The routine RUNS the task with your tools at its time (same approvals as a live turn) and writes the result here. Never claim a routine exists unless this tool said it was created.',
    ].join('\n'),
    parameters: Params(),
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const scope = deps.scopeOf();

      if (args.action === 'list') {
        const rows = mine(scope);
        if (rows.length === 0) {
          return reply(
            'No tienes rutinas programadas. Dime qué hago y cuándo, por ejemplo «cada lunes a las 9 revisa el gasto», y la programo.',
          );
        }
        return reply(rows.map(listLine).join('\n'));
      }

      if (args.action === 'create') {
        const said = String(args.said ?? '').trim();
        if (!said) return reply('create necesita said: qué hago y cuándo, con tus palabras.', true);
        const parsed = parseCronAdd(said, validateSchedule);
        if (!parsed.ok) return reply(parsed.error, true);
        if (parsed.prompt.length > MAX_TASK) {
          return reply(`La tarea pasa de ${MAX_TASK} caracteres; resúmela.`, true);
        }
        const tooOften = checkRoutineFrequency(parsed.schedule);
        if (tooOften) return reply(tooOften, true);
        if (mine(scope).length >= MAX_AGENT_ROUTINES_PER_CHAT) {
          return reply(
            `Ya hay ${MAX_AGENT_ROUTINES_PER_CHAT} rutinas programadas en este chat: quita alguna antes.`,
            true,
          );
        }
        const name = uniqueRoutineName(
          deps.store as Store,
          scope,
          routineNameFromPrompt(parsed.prompt),
        );
        const created = deps.store.saveRoutine({
          scope,
          name,
          kind: 'schedule',
          prompt: parsed.prompt,
          schedule: parsed.schedule,
        });
        deps.sync();
        const next = nextOf(created);
        return reply(
          [
            `Rutina "${created.name}" ${programadaRutinaEs(created)}.`,
            `Tarea: ${created.prompt}`,
            `Próxima ejecución: ${next ? formatNextRun(next.getTime(), now()) : 'sin próxima vez'}.`,
            'El resultado te avisará en este chat. Para pausarla o quitarla, dímelo.',
          ].join('\n'),
        );
      }

      // pause / resume / cancel: una palabra de la rutina basta para encontrarla.
      const needle = String(args.said ?? '').trim();
      if (!needle) {
        return reply(`${args.action} necesita said: una palabra de la rutina.`, true);
      }
      const hits = find(scope, needle);
      if (hits.length === 0) {
        return reply(`No encuentro ninguna rutina con "${needle}".`, true);
      }
      if (hits.length > 1) {
        return reply(
          `Hay ${hits.length} rutinas con "${needle}": ${hits.map((r) => r.name).join(' / ')}. Dime cuál.`,
          true,
        );
      }
      const [routine] = hits as [Routine];

      if (args.action === 'cancel') {
        deps.store.deleteRoutine(scope, routine.name);
        deps.sync();
        return reply(`Rutina "${routine.name}" quitada.`);
      }
      if (args.action === 'pause') {
        if (!routine.enabled) return reply(`La rutina "${routine.name}" ya estaba en pausa.`);
        deps.store.saveRoutine({
          scope,
          name: routine.name,
          kind: 'schedule',
          prompt: routine.prompt,
          schedule: routine.schedule,
          enabled: false,
        });
        deps.sync();
        return reply(
          `Rutina "${routine.name}" en pausa. Dime «reanuda la rutina ${routine.name}» y vuelve a su horario.`,
        );
      }
      // resume
      if (routine.enabled) return reply(`La rutina "${routine.name}" ya estaba en marcha.`);
      deps.store.saveRoutine({
        scope,
        name: routine.name,
        kind: 'schedule',
        prompt: routine.prompt,
        schedule: routine.schedule,
        enabled: true,
      });
      deps.sync();
      const back = deps.store.getRoutine(scope, routine.name) ?? routine;
      const next = nextOf(back);
      return reply(
        `Rutina "${routine.name}" otra vez en marcha (${horarioRutinaEs(back) ?? back.schedule ?? ''}). Próxima ejecución: ${
          next ? formatNextRun(next.getTime(), now()) : 'sin próxima vez'
        }.`,
      );
    },
  };
}
