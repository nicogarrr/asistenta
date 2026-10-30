import { isCommandRoutine } from '../command-routine.js';
import { isGoalRoutine } from '../goals/runner.js';
import { dentroDeEs, fechaCortaEs, isReminder, reminderText } from '../tools/reminder.js';

/** Lo mínimo que el panel necesita de cada rutina programada (RoutineRunner.status()). */
export interface NextUpScheduled {
  scope: string;
  name: string;
  next: string | null;
}

export interface NextUpRoutine {
  name: string;
  prompt: string | null;
}

export interface PanelNextUp {
  proximoRecordatorio: string | null;
  proximaRutina: string | null;
}

/**
 * Ámbitos que el panel (solo del dueño) puede enseñar: su chat privado de Telegram
 * (cualquier hilo) y lo local. Nunca grupos ni el privado de otra persona.
 */
export function panelScopeVisible(scope: string, ownerId?: string | number): boolean {
  if (scope === 'local' || scope === '') return true;
  if (ownerId === undefined || ownerId === null || String(ownerId) === '') return false;
  const base = `telegram:dm:${String(ownerId)}`;
  return scope === base || scope.startsWith(`${base}#`);
}

function cuando(next: Date, now: Date): string {
  return `${fechaCortaEs(next)} (${dentroDeEs(next.getTime() - now.getTime())})`;
}

/**
 * Próximo recordatorio y próxima rutina del dueño para la tarjeta Estado del panel.
 * Las rutinas de objetivos no cuentan; las de comando (PA_CRON_COMANDOS) llevan «· comando».
 */
export function panelNextUp(
  scheduled: readonly NextUpScheduled[],
  routine: (scope: string, name: string) => NextUpRoutine | null | undefined,
  ownerId?: string | number,
  now: Date = new Date(),
): PanelNextUp {
  let recordatorio: { at: Date; texto: string } | null = null;
  let rutina: { at: Date; texto: string } | null = null;
  for (const item of scheduled) {
    if (!item.next || !panelScopeVisible(item.scope, ownerId)) continue;
    const at = new Date(item.next);
    if (Number.isNaN(at.getTime()) || at.getTime() < now.getTime()) continue;
    const r = routine(item.scope, item.name);
    if (!r || isGoalRoutine(r)) continue;
    if (isReminder(r)) {
      if (!recordatorio || at < recordatorio.at) {
        recordatorio = { at, texto: `${reminderText(r)} — ${cuando(at, now)}` };
      }
    } else if (!rutina || at < rutina.at) {
      const marca = isCommandRoutine(r) ? ' · comando' : '';
      rutina = { at, texto: `${r.name}${marca} — ${cuando(at, now)}` };
    }
  }
  return {
    proximoRecordatorio: recordatorio?.texto ?? null,
    proximaRutina: rutina?.texto ?? null,
  };
}
