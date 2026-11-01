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
  return `${fechaCortaEs(next)} (${dentroDeEs(next.getTime() - now.getTime(), now.getTime())})`;
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

/** Lo que el panel lee de cada rutina guardada (store.listRoutines()). */
export interface PanelRoutineSource {
  scope: string;
  name: string;
  kind: string;
  schedule: string | null;
  enabled: boolean;
  prompt: string | null;
  /** Última ejecución tal como la guarda el store (ISO), o null si nunca se ha ejecutado. */
  lastRunAt?: string | null;
}

/** Una fila de la tarjeta Rutinas (solo lectura). */
export interface PanelRoutine {
  nombre: string;
  horario: string;
  activa: boolean;
  /** «30 oct, 18:00 (en 2 h)», «Sin próxima ejecución» o «Pausada». */
  proxima: string;
  /** Texto de commandRoutineTag sin el icono, o null si habla con el modelo. */
  comando: string | null;
  /** «vie 30/10 18:00», o null si nunca se ha ejecutado (o la fecha guardada no se entiende). */
  ultima: string | null;
}

const MAX_RUTINAS = 50;

function ultimaEjecucion(guardada: string | null | undefined): string | null {
  if (!guardada) return null;
  const d = /^\d+$/.test(guardada) ? new Date(Number(guardada)) : new Date(guardada);
  return Number.isNaN(d.getTime()) ? null : fechaCortaEs(d);
}

/**
 * Rutinas programadas del dueño para la tarjeta Rutinas: mismo ámbito que Estado
 * (privado del dueño y local), sin recordatorios (ya salen en Estado) ni rutinas
 * de objetivos. Ordenadas por la próxima ejecución; las pausadas al final.
 */
export function panelRoutines(
  routines: readonly PanelRoutineSource[],
  scheduled: readonly NextUpScheduled[],
  tag: (r: PanelRoutineSource) => string,
  ownerId?: string | number,
  now: Date = new Date(),
): PanelRoutine[] {
  const vivas = new Map(scheduled.map((s) => [`${s.scope}\u0000${s.name}`, s.next]));
  const filas: { orden: number; fila: PanelRoutine }[] = [];
  for (const r of routines) {
    if (r.kind !== 'schedule' || !r.schedule || !panelScopeVisible(r.scope, ownerId)) continue;
    if (isGoalRoutine(r) || isReminder(r)) continue;
    const next = vivas.get(`${r.scope}\u0000${r.name}`);
    const at = next ? new Date(next) : null;
    const valida = !!at && !Number.isNaN(at.getTime()) && at.getTime() >= now.getTime();
    const marca = isCommandRoutine(r)
      ? tag(r)
          .replace(/^\s*⚙️\s*/u, '')
          .trim()
      : '';
    filas.push({
      orden: !r.enabled
        ? Number.MAX_SAFE_INTEGER
        : valida && at
          ? at.getTime()
          : Number.MAX_SAFE_INTEGER - 1,
      fila: {
        nombre: r.name,
        horario: r.schedule,
        activa: r.enabled,
        proxima: !r.enabled ? 'Pausada' : valida && at ? cuando(at, now) : 'Sin próxima ejecución',
        comando: isCommandRoutine(r) ? marca || 'comando' : null,
        ultima: ultimaEjecucion(r.lastRunAt),
      },
    });
  }
  filas.sort((a, b) => a.orden - b.orden || a.fila.nombre.localeCompare(b.fila.nombre, 'es'));
  return filas.slice(0, MAX_RUTINAS).map((f) => f.fila);
}
