import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { Routine, Store } from '../db.js';
import { validateSchedule } from '../routines.js';

/**
 * Reminders as a tool: "recuérdame dentro de 3 horas que apague el horno",
 * "mañana a las 9 llama al dentista", "todos los lunes a las 8:30 revisa los correos".
 *
 * They ride on the routine scheduler that already exists (cron in local time, one
 * firing at a time, delivery into the chat that asked), so there is no second
 * scheduler to keep in step. A reminder is a routine whose name starts with a marker:
 * `recordatorio:` repeats, `recordatorio-1:` fires once and the daemon deletes it after
 * it fires (see `isOneShotReminder`). A one-shot is a cron pinned to its minute, day and
 * month; without the delete it would come back next year.
 *
 * The scope comes from the caller, never from the model.
 */
export const REMINDER_PREFIX = 'recordatorio:';
export const REMINDER_ONCE_PREFIX = 'recordatorio-1:';

/**
 * A fresh routine holds its first fire for a minute (see routines.ts), so a reminder
 * closer than this would be silently late. Refused with a reason instead.
 */
export const MIN_REMINDER_MS = 2 * 60_000;
const MAX_TEXT = 200;

export function isReminder(r: Pick<Routine, 'name'>): boolean {
  return r.name.startsWith(REMINDER_PREFIX) || r.name.startsWith(REMINDER_ONCE_PREFIX);
}

export function isOneShotReminder(r: Pick<Routine, 'name'>): boolean {
  return r.name.startsWith(REMINDER_ONCE_PREFIX);
}

/** What the user reads in the chat when it fires. */
export function reminderText(r: Pick<Routine, 'name' | 'prompt'>): string {
  return r.prompt?.trim() || r.name.replace(/^recordatorio(?:-1)?:\s*/, '');
}

const Params = Type.Object({
  action: Type.Union([Type.Literal('create'), Type.Literal('list'), Type.Literal('cancel')]),
  text: Type.Optional(
    Type.String({
      description:
        'create: what to remind, in the second person ("apagar el horno"). cancel: a word from the reminder to cancel.',
    }),
  ),
  at: Type.Optional(
    Type.String({
      description:
        "create, one time: local date and time as YYYY-MM-DDTHH:MM (24h, the user's timezone). Work it out from the <now> block.",
    }),
  ),
  in_minutes: Type.Optional(
    Type.Number({
      description: 'create, one time: minutes from now (at least 2). Alternative to at.',
    }),
  ),
  schedule: Type.Optional(
    Type.String({
      description:
        'create, repeating: 5-field cron in local time (min hour day-of-month month day-of-week), e.g. "30 8 * * 1" for Mondays at 8:30.',
    }),
  ),
});

export interface ReminderDeps {
  store: Store;
  scopeOf: () => string;
  /** Registers new routines with the running scheduler (RoutineRunner.sync). */
  sync: () => void;
  now?: () => number;
}

const pad = (n: number): string => String(n).padStart(2, '0');

function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function reply(text: string, isError = false): AgentToolResult {
  return { content: [{ type: 'text', text }], details: {}, isError };
}

/** `YYYY-MM-DDTHH:MM` as local wall-clock time, or null when it is not one. */
export function parseLocalStamp(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(y, mo - 1, d, h, mi, 0, 0);
  // new Date rolls 31 February over to March: reject instead of firing on the wrong day.
  if (date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h) return null;
  return date;
}

/** Cron pinned to one minute, day and month: fires once a year, and we delete it after. */
export function onceCron(d: Date): string {
  return `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
}

function nameFor(prefix: string, text: string, suffix = ''): string {
  return `${prefix} ${text.replace(/\s+/g, ' ').slice(0, 60)}${suffix}`.trim();
}

export function createReminderTool(deps: ReminderDeps): AgentTool<typeof Params> {
  const now = deps.now ?? (() => Date.now());
  return {
    name: 'reminder',
    label: 'Reminder',
    description: [
      'Reminders the user asked for: a message in this chat at the time they said.',
      'action=create with text plus ONE of: at (YYYY-MM-DDTHH:MM local), in_minutes (>= 2),',
      'or schedule (5-field cron, for repeating ones like every Monday 8:30).',
      "action=list shows this chat's reminders with their next time; action=cancel with a",
      'word from the text removes it. Say back the exact time you set, in local time.',
      'Never claim a reminder exists unless this tool said it was created.',
    ].join('\n'),
    parameters: Params,
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const scope = deps.scopeOf();
      const mine = () => deps.store.listRoutines(scope).filter(isReminder);

      if (args.action === 'list') {
        const rows = mine();
        if (rows.length === 0) return reply('No hay recordatorios programados.');
        const lines = rows.map((r) => {
          const check = r.schedule ? validateSchedule(r.schedule) : null;
          const next = check?.ok ? check.next : 'sin próxima ejecución';
          const kind = isOneShotReminder(r) ? 'una vez' : `repite (${r.schedule})`;
          return `- ${reminderText(r)} | ${kind} | próximo: ${next}`;
        });
        return reply(lines.join('\n'));
      }

      if (args.action === 'cancel') {
        const needle = String(args.text ?? '')
          .trim()
          .toLowerCase();
        if (!needle) return reply('cancel necesita text: una palabra del recordatorio.', true);
        const hits = mine().filter((r) => reminderText(r).toLowerCase().includes(needle));
        if (hits.length === 0)
          return reply(`No encuentro ningún recordatorio con "${needle}".`, true);
        if (hits.length > 1) {
          return reply(
            `Hay ${hits.length} recordatorios con "${needle}": ${hits.map(reminderText).join(' / ')}. Dime cuál.`,
            true,
          );
        }
        const [hit] = hits as [Routine];
        deps.store.deleteRoutine(scope, hit.name);
        deps.sync();
        return reply(`Cancelado: ${reminderText(hit)}.`);
      }

      const text = String(args.text ?? '').trim();
      if (!text) return reply('create necesita text.', true);
      if (text.length > MAX_TEXT) return reply(`El texto pasa de ${MAX_TEXT} caracteres.`, true);
      const given = [args.at, args.in_minutes, args.schedule].filter((v) => v !== undefined);
      if (given.length !== 1) {
        return reply('create necesita exactamente uno de: at, in_minutes o schedule.', true);
      }

      if (args.schedule !== undefined) {
        const check = validateSchedule(args.schedule);
        if (!check.ok) return reply(`Horario no válido: ${check.error}`, true);
        deps.store.saveRoutine({
          scope,
          name: nameFor(REMINDER_PREFIX, text),
          kind: 'schedule',
          prompt: text,
          schedule: args.schedule.trim(),
        });
        deps.sync();
        return reply(
          `Recordatorio programado (repite ${args.schedule.trim()}): ${text}. Próximo: ${check.next}.`,
        );
      }

      let when: Date;
      if (args.in_minutes !== undefined) {
        if (!Number.isFinite(args.in_minutes)) return reply('in_minutes no es un número.', true);
        when = new Date(now() + Math.round(args.in_minutes) * 60_000);
      } else {
        const parsed = parseLocalStamp(String(args.at));
        if (!parsed) return reply('at debe ser YYYY-MM-DDTHH:MM (hora local, fecha real).', true);
        when = parsed;
      }
      if (when.getTime() - now() < MIN_REMINDER_MS) {
        return reply(
          `Eso es ahora o ya pasó (${stamp(when)}). El mínimo son 2 minutos desde ahora; dime otra hora.`,
          true,
        );
      }
      deps.store.saveRoutine({
        scope,
        name: nameFor(REMINDER_ONCE_PREFIX, text, ` @${stamp(when)}`),
        kind: 'schedule',
        prompt: text,
        schedule: onceCron(when),
      });
      deps.sync();
      return reply(`Recordatorio programado para ${stamp(when)} (hora local): ${text}.`);
    },
  };
}
