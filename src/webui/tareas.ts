import {
  type BoardTask,
  dayLabel,
  REPEAT_LABEL,
  STATUS_LABEL,
  type TaskBoard,
} from '../tasks/board.js';
import { panelScopeVisible } from './next-up.js';

export interface PanelTarea {
  dia: string;
  hora?: string;
  titulo: string;
  estado: string;
  /** «cada semana», «cada día»… si la tarea se repite. */
  repite?: string;
}

export interface PanelTareas {
  tareas: PanelTarea[];
  atrasadas: PanelTarea[];
}

const fila = (t: BoardTask): PanelTarea => ({
  dia: dayLabel(t.day),
  ...(t.time ? { hora: t.time } : {}),
  titulo: t.title,
  estado: STATUS_LABEL[t.status],
  ...(t.repeat && REPEAT_LABEL[t.repeat] ? { repite: REPEAT_LABEL[t.repeat] } : {}),
});

/**
 * Tarjeta «Tareas de la semana» del panel: solo lectura y solo lo del dueño
 * (su chat privado o lo local), nunca grupos ni chats de otras personas.
 */
export function panelTareas(
  board: Pick<TaskBoard, 'week'>,
  ownerId?: string | number,
): PanelTareas {
  const semana = board.week(undefined);
  const suya = (t: BoardTask): boolean => panelScopeVisible(t.scope, ownerId);
  return {
    tareas: semana.tasks.filter(suya).map(fila),
    atrasadas: semana.overdue.filter(suya).map(fila),
  };
}
