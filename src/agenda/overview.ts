/** One read-only view for the command and normal conversation. No mail or side effects. */

import type { Followup } from '../alerts/followups.js';
import type { Goal } from '../goals/store.js';
import { type BoardTask, dayLabel, localDay } from '../tasks/board.js';
import type { CalendarSnapshot } from './ics.js';
import { buildAgenda, calendarDaysFor, formatAgenda } from './unified.js';

export interface AgendaOverviewDeps {
  authorised: () => boolean;
  calendar: (days: number) => Promise<CalendarSnapshot>;
  followups: () => Followup[];
  routines: () => string;
  goals: () => Array<Pick<Goal, 'title' | 'status' | 'plan'>>;
  /** Tablero de tareas de este chat (opcional): lo pendiente de estos días y lo atrasado. */
  tasks?: () => Array<Pick<BoardTask, 'title' | 'day' | 'time' | 'status'>>;
  now?: () => number;
}
const labels: Record<Goal['status'], string> = {
  proposed: 'propuesto, espera aprobación',
  active: 'activo',
  paused: 'pausado',
  blocked: 'bloqueado',
  done: 'cumplido',
  cancelled: 'cancelado',
};
export async function readAgendaOverview(
  deps: AgendaOverviewDeps,
  requestedDays = 7,
): Promise<string> {
  // Do not even load private sources until the caller's identity is checked.
  if (!deps.authorised()) return 'Agenda personal solo disponible en el chat privado del dueño.';
  const days = Number.isFinite(requestedDays)
    ? Math.max(1, Math.min(60, Math.round(requestedDays)))
    : 7;
  // The calendar reads from today; the agenda shows today plus `days` after it.
  const calendar = await deps.calendar(calendarDaysFor(days));
  const agenda = await buildAgenda({
    calendar: async () => calendar.events,
    followups: () => deps.followups().filter((f) => f.status === 'pending'),
    days,
    now: deps.now,
  });
  if (calendar.reason) agenda.notes.push(calendar.reason);
  const goals = deps.goals().filter((g) => g.status !== 'done' && g.status !== 'cancelled');
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  const sections = [formatAgenda(agenda), deps.routines()];
  const today = localDay(new Date(deps.now?.() ?? Date.now()));
  const last = localDay(new Date(new Date(`${today}T12:00:00`).getTime() + days * 86_400_000));
  const tasks = (deps.tasks?.() ?? [])
    .filter((t) => t.status !== 'hecho' && t.day <= last)
    .slice(0, 15);
  if (tasks.length)
    sections.push(
      [
        'Tareas',
        ...tasks.map(
          (t) =>
            `- ${t.day < today ? 'atrasada' : dayLabel(t.day)}${t.time ? ` ${t.time}` : ''}: ${clean(t.title)}${t.status === 'en_curso' ? ' (en curso)' : ''}`,
        ),
      ].join('\n'),
    );
  if (goals.length)
    sections.push(
      [
        'Objetivos abiertos',
        ...goals.map((g) => {
          const next = g.plan.find((step) => !step.done);
          return `- ${clean(g.title)} (${labels[g.status]})${next ? `: siguiente ${clean(next.text)}` : ''}`;
        }),
      ].join('\n'),
    );
  sections.push(
    'Calendario local y feed iCal (el feed puede ir con retraso). Correo no incluido en esta consulta.',
  );
  return sections.filter(Boolean).join('\n\n');
}
