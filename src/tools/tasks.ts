import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  type BoardTask,
  dayLabel,
  normaliseTime,
  resolveDay,
  resolveStatus,
  STATUS_LABEL,
  type TaskBoard,
} from '../tasks/board.js';

const Params = Type.Object({
  action: Type.Union(
    [
      Type.Literal('apuntar'),
      Type.Literal('ver'),
      Type.Literal('marcar'),
      Type.Literal('mover'),
      Type.Literal('borrar'),
    ],
    { description: 'apuntar | ver | marcar | mover | borrar' },
  ),
  titulo: Type.Optional(
    Type.String({ description: 'apuntar: what to do, short («llamar al banco»).' }),
  ),
  dia: Type.Optional(
    Type.String({
      description:
        'apuntar/mover: «hoy», «mañana», «jueves», «jueves que viene», «12 de noviembre», «dentro de 3 días», «5/11» or YYYY-MM-DD.',
    }),
  ),
  hora: Type.Optional(
    Type.String({ description: 'Optional local time: HH:MM, «5 de la tarde», «diez y media».' }),
  ),
  semana: Type.Optional(
    Type.Union([Type.Literal('esta'), Type.Literal('proxima')], {
      description: 'ver: this week (default) or next.',
    }),
  ),
  tarea: Type.Optional(
    Type.String({
      description: 'marcar/mover/borrar: the task number or a few words of it («banco»).',
    }),
  ),
  estado: Type.Optional(Type.String({ description: 'marcar: pendiente | en curso | hecho.' })),
});

export interface TasksToolDeps {
  board: TaskBoard;
  scopeOf: () => string;
}

const line = (t: BoardTask): string =>
  `${t.status === 'hecho' ? '✓ ' : ''}${t.title}${t.time ? ` (${t.time})` : ''}${t.status === 'en_curso' ? ', en curso' : ''} [${t.id}]`;

export function weekText(board: TaskBoard, scope: string | undefined, next = false): string {
  const base = next ? board.week(scope).to : board.today();
  const day = next ? nextDay(base) : base;
  const w = board.week(scope, day);
  const head = next ? 'La semana que viene' : 'Esta semana';
  const out: string[] = [];
  if (w.tasks.length === 0) out.push(`${head} no tienes nada apuntado.`);
  else {
    out.push(`${head}:`);
    let current = '';
    for (const t of w.tasks) {
      if (t.day !== current) {
        current = t.day;
        out.push(`${dayLabel(t.day)}:`);
      }
      out.push(`  ${line(t)}`);
    }
    const done = w.tasks.filter((t) => t.status === 'hecho').length;
    out.push(`${done} de ${w.tasks.length} hechas.`);
  }
  if (!next && w.overdue.length > 0) {
    out.push(
      `Sin hacer de antes: ${w.overdue
        .slice(0, 5)
        .map((t) => `${t.title} (${dayLabel(t.day)}) [${t.id}]`)
        .join('; ')}.`,
    );
  }
  return out.join('\n');
}

function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const at = new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1, 12);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/**
 * Tablero semanal de tareas del dueño, desde el chat. Todo local (un JSON en el estado);
 * borrar solo con orden escrita. Una tarea con hora no crea aviso por su cuenta: la
 * respuesta pregunta si quiere recordatorio y eso lo hace la herramienta `reminder`.
 */
export function createTasksTool(deps: TasksToolDeps): AgentTool<typeof Params> {
  return {
    name: 'tareas',
    label: 'Tareas de la semana',
    description: [
      "The owner's weekly task board (local). Use for «apúntame para el jueves llamar al banco»,",
      '«¿qué tengo esta semana?», «marca hecho lo del banco», «pasa lo del banco al viernes».',
      'apuntar: titulo + dia (+ hora). ver: semana esta|proxima. marcar: tarea + estado',
      '(pendiente|en curso|hecho). mover: tarea + dia. borrar: only when the owner explicitly asks.',
      'A task with a time does NOT remind by itself: offer a reminder and use the reminder tool if he says yes.',
      'For planning an event, apuntar one task per step, then ask him only what is really missing.',
    ].join('\n'),
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const text = run(deps, args);
      return { content: [{ type: 'text', text }], details: {} };
    },
  };
}

type Args = {
  action: string;
  titulo?: string;
  dia?: string;
  hora?: string;
  semana?: string;
  tarea?: string;
  estado?: string;
};

function pick(
  deps: TasksToolDeps,
  ref: string | undefined,
  preferOpen: boolean,
): BoardTask | string {
  if (!ref?.trim()) return '¿Qué tarea? Dime unas palabras o su número.';
  let found = deps.board.find(deps.scopeOf(), ref);
  if (found.length > 1 && preferOpen) {
    const open = found.filter((t) => t.status !== 'hecho');
    if (open.length > 0) found = open;
  }
  if (found.length === 0) return `No encuentro ninguna tarea con «${ref.trim()}».`;
  if (found.length > 1) {
    return `Hay varias: ${found
      .slice(0, 5)
      .map((t) => `[${t.id}] ${t.title} (${dayLabel(t.day)})`)
      .join('; ')}. ¿Cuál?`;
  }
  return found[0] as BoardTask;
}

function run(deps: TasksToolDeps, args: Args): string {
  const board = deps.board;
  const now = new Date(`${board.today()}T12:00:00`);
  switch (args.action) {
    case 'ver':
      return weekText(board, deps.scopeOf(), args.semana === 'proxima');
    case 'apuntar': {
      const title = args.titulo?.trim();
      if (!title) return '¿Qué apunto?';
      const day = resolveDay(args.dia?.trim() || 'hoy', now);
      if (!day) return `No entiendo el día «${args.dia}». Dímelo como «jueves» o «5/11».`;
      const time = normaliseTime(args.hora);
      if (time === null) return `No entiendo la hora «${args.hora}». Dímela como 10:30.`;
      const t = board.add(deps.scopeOf(), title, day, time);
      const when = day === board.today() ? 'hoy' : `el ${dayLabel(day)}`;
      return `Apuntado para ${when}: ${t.title}${time ? ` a las ${time}` : ''}.${time ? ' ¿Te lo recuerdo a esa hora?' : ''}`;
    }
    case 'marcar': {
      const status = resolveStatus(args.estado ?? 'hecho');
      if (!status) return `No entiendo el estado «${args.estado}»: pendiente, en curso o hecho.`;
      const t = pick(deps, args.tarea, status !== 'pendiente');
      if (typeof t === 'string') return t;
      board.setStatus(t.id, status);
      if (status === 'hecho') return `Hecho: ${t.title} ✓`;
      return `${t.title}: ${STATUS_LABEL[status]}.`;
    }
    case 'mover': {
      const day = resolveDay(args.dia?.trim() ?? '', now);
      if (!day) return `No entiendo el día «${args.dia ?? ''}». Dímelo como «viernes» o «5/11».`;
      const time = normaliseTime(args.hora);
      if (time === null) return `No entiendo la hora «${args.hora}».`;
      const t = pick(deps, args.tarea, true);
      if (typeof t === 'string') return t;
      board.move(t.id, day, time);
      return `Movido al ${dayLabel(day)}: ${t.title}.`;
    }
    case 'borrar': {
      const t = pick(deps, args.tarea, false);
      if (typeof t === 'string') return t;
      board.remove(t.id);
      return `Borrada: ${t.title}.`;
    }
    default:
      return 'Acción desconocida: apuntar, ver, marcar, mover o borrar.';
  }
}
