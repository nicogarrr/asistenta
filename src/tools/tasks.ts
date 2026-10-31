import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import {
  type BoardTask,
  dayLabel,
  fold,
  normaliseTime,
  REPEAT_LABEL,
  resolveDay,
  resolveRepeat,
  resolveStatus,
  STATUS_LABEL,
  type TaskBoard,
  type TaskRepeat,
} from '../tasks/board.js';

const Params = Type.Object({
  action: Type.Union(
    [
      Type.Literal('apuntar'),
      Type.Literal('ver'),
      Type.Literal('marcar'),
      Type.Literal('mover'),
      Type.Literal('borrar'),
      Type.Literal('renombrar'),
      Type.Literal('repetir'),
    ],
    { description: 'apuntar | ver | marcar | mover | borrar | renombrar | repetir' },
  ),
  titulo: Type.Optional(
    Type.String({ description: 'apuntar/renombrar: what to do, short («llamar al banco»).' }),
  ),
  dia: Type.Optional(
    Type.String({
      description:
        'apuntar/mover, or ver one day: «hoy», «mañana», «jueves», «jueves que viene», «12 de noviembre», «dentro de 3 días», «5/11» or YYYY-MM-DD.',
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
  repetir: Type.Optional(
    Type.String({
      description:
        'apuntar/repetir: «todos los lunes», «cada día», «de lunes a viernes», «cada mes»; «no» stops it.',
    }),
  ),
});

export interface TasksToolDeps {
  board: TaskBoard;
  scopeOf: () => string;
}

const line = (t: BoardTask): string =>
  `${t.status === 'hecho' ? '✓ ' : ''}${t.title}${t.time ? ` (${t.time})` : ''}${t.repeat ? ` (${REPEAT_LABEL[t.repeat]})` : ''}${t.status === 'en_curso' ? ', en curso' : ''} [${t.id}]`;

/** «¿Qué tengo hoy?»: solo ese día (y lo atrasado, si es hoy). */
export function dayText(board: TaskBoard, scope: string | undefined, day: string): string {
  const today = board.today();
  const w = board.week(scope, day);
  const tasks = w.tasks.filter((t) => t.day === day);
  const head = day === today ? 'Hoy' : day === nextDay(today) ? 'Mañana' : `El ${dayLabel(day)}`;
  const out =
    tasks.length === 0
      ? [`${head} no tienes nada apuntado.`]
      : [`${head}:`, ...tasks.map((t) => `  ${line(t)}`)];
  const now = board.week(scope);
  const late = [...now.overdue, ...now.tasks.filter((t) => t.day < today && t.status !== 'hecho')];
  if (day === today && late.length > 0) {
    out.push(
      `Sin hacer de antes: ${late
        .slice(0, 5)
        .map((t) => `${t.title} (${dayLabel(t.day)}) [${t.id}]`)
        .join('; ')}.`,
    );
  }
  return out.join('\n');
}

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
      'apuntar: titulo + dia (+ hora). ver: semana esta|proxima, or dia for one day. marcar: tarea + estado',
      '(pendiente|en curso|hecho). mover: tarea + dia and/or hora («pásalo a las 11»; hora «sin hora» removes it;',
      'tarea «lo atrasado» moves every overdue open task). renombrar: tarea + titulo.',
      'repetir: tarea + repetir (also on apuntar, e.g. «todos los lunes sacar la basura»; «no» stops it).',
      'borrar: only when the owner explicitly asks.',
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
  repetir?: string;
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

function repeatHelp(said: string | undefined): string {
  return `No entiendo cada cuánto «${said ?? ''}». Dime «cada día», «todos los lunes», «de lunes a viernes» o «cada mes».`;
}

/** «Pasa lo atrasado a hoy»: todas las pendientes de días pasados, al día pedido. */
function moveOverdue(deps: TasksToolDeps, day: string): string {
  const board = deps.board;
  const late = board
    .all(deps.scopeOf())
    .filter((t) => t.day < board.today() && t.status !== 'hecho');
  if (late.length === 0) return 'No tienes nada atrasado.';
  for (const t of late) board.move(t.id, day);
  const when = day === board.today() ? 'hoy' : `el ${dayLabel(day)}`;
  const n = late.length === 1 ? '1 tarea' : `${late.length} tareas`;
  return `Pasadas a ${when} ${n}: ${late
    .slice(0, 8)
    .map((t) => t.title)
    .join(', ')}${late.length > 8 ? '…' : ''}.`;
}

function run(deps: TasksToolDeps, args: Args): string {
  const board = deps.board;
  const now = new Date(`${board.today()}T12:00:00`);
  switch (args.action) {
    case 'ver': {
      if (args.dia?.trim() && args.semana !== 'proxima') {
        const day = resolveDay(args.dia.trim(), now);
        if (!day) return `No entiendo el día «${args.dia}». Dímelo como «jueves» o «5/11».`;
        return dayText(board, deps.scopeOf(), day);
      }
      return weekText(board, deps.scopeOf(), args.semana === 'proxima');
    }
    case 'apuntar': {
      const title = args.titulo?.trim();
      if (!title) return '¿Qué apunto?';
      const day = resolveDay(args.dia?.trim() || 'hoy', now);
      if (!day) return `No entiendo el día «${args.dia}». Dímelo como «jueves» o «5/11».`;
      const time = normaliseTime(args.hora);
      if (time === null) return `No entiendo la hora «${args.hora}». Dímela como 10:30.`;
      const rep = args.repetir?.trim() ? resolveRepeat(args.repetir) : 'no';
      if (rep === null) return repeatHelp(args.repetir);
      const repeat: TaskRepeat | undefined = rep === 'no' ? undefined : rep;
      const same = board
        .week(deps.scopeOf(), day)
        .tasks.find(
          (o) =>
            o.day === day &&
            o.status !== 'hecho' &&
            (o.time ?? '') === (time ?? '') &&
            fold(o.title) === fold(title),
        );
      if (same) {
        const cuando = day === board.today() ? 'hoy' : `el ${dayLabel(day)}`;
        return `Ya lo tenías apuntado para ${cuando}: ${same.title}${same.time ? ` a las ${same.time}` : ''} [${same.id}].`;
      }
      const t = board.add(deps.scopeOf(), title, day, time, repeat);
      const when = day === board.today() ? 'hoy' : `el ${dayLabel(day)}`;
      const every = repeat ? ` (${REPEAT_LABEL[repeat]})` : '';
      const n = board.now();
      const clock = `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
      // A las 18:00, «llamar a Ana a las 10» ya pasó: no ofrecer un recordatorio imposible.
      const past = Boolean(time && day === board.today() && time < clock);
      const tail = !time
        ? ''
        : past
          ? ' Esa hora ya ha pasado hoy; si era para mañana, dime «pásalo a mañana».'
          : ' ¿Te lo recuerdo a esa hora?';
      return `Apuntado para ${when}: ${t.title}${time ? ` a las ${time}` : ''}${every}.${tail}`;
    }
    case 'marcar': {
      const status = resolveStatus(args.estado ?? 'hecho');
      if (!status) return `No entiendo el estado «${args.estado}»: pendiente, en curso o hecho.`;
      const t = pick(deps, args.tarea, status !== 'pendiente');
      if (typeof t === 'string') return t;
      const r = board.setStatus(t.id, status);
      if (status === 'hecho' && r?.next) {
        return `Hecho: ${t.title} ✓ La próxima, el ${dayLabel(r.next.day)}.`;
      }
      if (status === 'hecho') return `Hecho: ${t.title} ✓`;
      return `${t.title}: ${STATUS_LABEL[status]}.`;
    }
    case 'mover': {
      const dayText = args.dia?.trim() ?? '';
      const noTime = /^(?:sin hora|ninguna|quita(?:r|le)? la hora)$/.test(fold(args.hora ?? ''));
      const time = noTime ? null : normaliseTime(args.hora);
      if (time === null && !noTime) return `No entiendo la hora «${args.hora}».`;
      if (!dayText && time === undefined) return '¿A qué día o a qué hora la paso?';
      const day = dayText ? resolveDay(dayText, now) : undefined;
      if (day === null) return `No entiendo el día «${dayText}». Dímelo como «viernes» o «5/11».`;
      if (
        /^(?:todo )?(?:lo )?atrasad[oa]s?$|^(?:las )?(?:tareas )?atrasadas$/.test(
          fold(args.tarea ?? ''),
        )
      ) {
        return moveOverdue(deps, day ?? board.today());
      }
      const t = pick(deps, args.tarea, true);
      if (typeof t === 'string') return t;
      const moved = board.move(t.id, day ?? t.day, time);
      const label = dayLabel(moved?.day ?? t.day);
      if (!day && noTime) return `Sin hora, el ${label}: ${t.title}.`;
      if (!day) return `Cambiado a las ${time} del ${label}: ${t.title}.`;
      return `Movido al ${label}: ${t.title}.`;
    }
    case 'repetir': {
      const rep = resolveRepeat(args.repetir ?? '');
      if (rep === null) return repeatHelp(args.repetir);
      const t = pick(deps, args.tarea, true);
      if (typeof t === 'string') return t;
      board.setRepeat(t.id, rep === 'no' ? undefined : rep);
      if (rep === 'no') return `Ya no se repite: ${t.title}.`;
      return `Ahora «${t.title}» se repite ${REPEAT_LABEL[rep]}.`;
    }
    case 'renombrar': {
      const title = args.titulo?.trim();
      const t = pick(deps, args.tarea, true);
      if (typeof t === 'string') return t;
      if (!title) return '¿Cómo la llamo?';
      const r = board.rename(t.id, title);
      return `Cambiado: «${t.title}» → «${r?.title ?? title}».`;
    }
    case 'borrar': {
      const t = pick(deps, args.tarea, false);
      if (typeof t === 'string') return t;
      board.remove(t.id);
      return `Borrada: ${t.title}.`;
    }
    default:
      return 'Acción desconocida: apuntar, ver, marcar, mover, renombrar, repetir o borrar.';
  }
}
