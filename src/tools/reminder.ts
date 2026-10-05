import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Cron } from 'croner';
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
/**
 * The pinned cron has no year field, so a date further than this would fire a year
 * early (and the daemon would delete it). 330 days leaves a margin for leap years.
 */
export const MAX_AHEAD_MS = 330 * 86_400_000;
/** A repeating reminder may not fire more often than this: the model must not be able to flood a chat. */
export const MIN_REPEAT_MS = 60 * 60_000;
export const MAX_REMINDERS_PER_CHAT = 30;
export const RETRY_MS = 5 * 60_000;

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

/**
 * Repeating schedules: five fields only (no seconds) and at least an hour between any
 * two of the next firings, so "* * * * *" or "0,1 8 * * *" is refused.
 */
export function checkRepeating(expr: string): string | null {
  const fields = expr.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    return 'Un recordatorio repetido usa 5 campos (min hora día mes díaSemana), sin segundos.';
  }
  const runs = new Cron(fields.join(' '), { paused: true }).nextRuns(8);
  for (let i = 1; i < runs.length; i++) {
    const gap = (runs[i]?.getTime() ?? 0) - (runs[i - 1]?.getTime() ?? 0);
    if (gap < MIN_REPEAT_MS) {
      return 'Un recordatorio repetido no puede dispararse más de una vez por hora.';
    }
  }
  return null;
}

/** The time the user asked for, kept at the end of a one-shot's name (`... @YYYY-MM-DD HH:MM`). */
export function dueOfOneShot(name: string): Date | null {
  const m = /@(\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/.exec(name);
  return m?.[1] ? parseLocalStamp(m[1]) : null;
}

/** A reminder that still cannot be delivered an hour after its time is dropped, not retried forever. */
export const RETRY_MAX_AGE_MS = 60 * 60_000;

/**
 * After a one-time reminder fired: delete it when it was delivered, otherwise move it
 * five minutes ahead so a Telegram failure does not make it vanish silently. Past
 * RETRY_MAX_AGE_MS (a blocked chat, say) it is dropped so it cannot retry forever; the
 * caller logs that. Returns what happened.
 */
export function settleOneShot(
  store: Pick<Store, 'deleteRoutine' | 'saveRoutine'>,
  routine: Pick<Routine, 'scope' | 'name' | 'prompt'>,
  delivered: boolean,
  now = Date.now(),
): 'deleted' | 'retry' | 'dropped' {
  if (delivered) {
    store.deleteRoutine(routine.scope, routine.name);
    return 'deleted';
  }
  const due = dueOfOneShot(routine.name);
  if (due && now - due.getTime() > RETRY_MAX_AGE_MS) {
    store.deleteRoutine(routine.scope, routine.name);
    return 'dropped';
  }
  store.saveRoutine({
    scope: routine.scope,
    name: routine.name,
    kind: 'schedule',
    prompt: routine.prompt,
    schedule: onceCron(new Date(now + RETRY_MS)),
  });
  return 'retry';
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

      if (mine().length >= MAX_REMINDERS_PER_CHAT) {
        return reply(
          `Ya hay ${MAX_REMINDERS_PER_CHAT} recordatorios en este chat: cancela alguno antes.`,
          true,
        );
      }

      if (args.schedule !== undefined) {
        const check = validateSchedule(args.schedule);
        if (!check.ok) return reply(`Horario no válido: ${check.error}`, true);
        const tooOften = checkRepeating(args.schedule);
        if (tooOften) return reply(tooOften, true);
        deps.store.saveRoutine({
          scope,
          name: nameFor(REMINDER_PREFIX, text, ` [${args.schedule.trim()}]`),
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
      if (when.getTime() - now() > MAX_AHEAD_MS) {
        return reply(
          'Solo puedo programar recordatorios puntuales a menos de 11 meses vista (el planificador no guarda el año). Dime una fecha más cercana.',
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
