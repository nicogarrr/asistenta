import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Cron } from 'croner';
import { Type } from 'typebox';
import { localDay, localTimeZone, wallClock, zonedTime } from '../datecontext.js';
import type { Routine, Store } from '../db.js';
import { OneTapIds } from '../one-tap-ids.js';
import { nextScheduleRun, validateSchedule } from '../routines.js';

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
  until: Type.Optional(
    Type.String({
      description:
        'create, repeating only: last local day it may fire, YYYY-MM-DD ("cada día durante una semana", "hasta el viernes"). Omit when it has no end.',
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
  const w = wallClock(d);
  return `${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}`;
}

function reply(text: string, isError = false): AgentToolResult {
  return { content: [{ type: 'text', text }], details: {}, isError };
}

/**
 * `YYYY-MM-DDTHH:MM` as wall-clock time in the configured zone (PA_TIMEZONE),
 * or null when it is not one. croner fires in that zone (#485), so reading the
 * stamp — and writing `onceCron` — in the process TZ would put a reminder an
 * hour off whenever the two differ.
 */
export function parseLocalStamp(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/.exec(raw.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const zone = localTimeZone();
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  // Two passes settle the zone offset, DST changes included.
  let at = naive;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(new Date(at), zone);
    at -= Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - naive;
  }
  const date = new Date(at);
  // 31 February rolls over and 02:30 on the spring-forward night does not exist:
  // reject instead of firing on the wrong day or hour.
  const w = wallClock(date, zone);
  if (w.year !== y || w.month !== mo || w.day !== d || w.hour !== h || w.minute !== mi) return null;
  return date;
}

/** Cron pinned to one minute, day and month: fires once a year, and we delete it after. */
export function onceCron(d: Date): string {
  const w = wallClock(d);
  return `${w.minute} ${w.hour} ${w.day} ${w.month} *`;
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
  const runs = new Cron(fields.join(' '), { paused: true, timezone: localTimeZone() }).nextRuns(8);
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

/**
 * A repeating reminder («cada día a las 9 la pastilla») whose send failed — no
 * internet, Telegram down — lost that day's notice: nothing retried it, unlike a
 * one-time reminder. Park a one-time copy pinned to this slot, five minutes ahead,
 * so the one-time path retries it, delivers it late at startup, or drops and
 * records it after RETRY_MAX_AGE_MS. Returns the parked name.
 */
export function parkFailedRepeating(
  store: Pick<Store, 'saveRoutine'>,
  routine: Pick<Routine, 'scope' | 'name' | 'prompt'>,
  now = Date.now(),
): string {
  const text = reminderText(routine);
  const name = nameFor(REMINDER_ONCE_PREFIX, text, ` @${stamp(new Date(now))}`);
  store.saveRoutine({
    scope: routine.scope,
    name,
    kind: 'schedule',
    prompt: text,
    schedule: onceCron(new Date(now + RETRY_MS)),
  });
  return name;
}

/**
 * One-time reminders whose time already passed when this runs (startup). The
 * scheduler never fires a past cron late: it would sit in the store and fire a YEAR
 * later (the pinned cron has no year), so the user would never hear about it. Every
 * overdue one is returned, with no grace: a cron does not fire a reminder that is
 * already behind, so a short grace would lose exactly those. Callers must run this
 * BEFORE the scheduler starts, so a job due this minute cannot also fire fresh.
 *
 * `invalid` are one-shots whose stored time is not a real local time (a date skipped
 * by a DST change, a corrupt name): they are reported, never given an invented time.
 */
export function missedOneShots(
  routines: readonly Routine[],
  now = Date.now(),
): { missed: Routine[]; invalid: Routine[] } {
  const missed: Routine[] = [];
  const invalid: Routine[] = [];
  for (const r of routines) {
    if (!isOneShotReminder(r) || !r.enabled) continue;
    const due = dueOfOneShot(r.name);
    if (due === null) invalid.push(r);
    else if (due.getTime() <= now) missed.push(r);
  }
  return { missed, invalid };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * What the user reads for a reminder delivered late. It states only what is known:
 * the time it was set for. It does not say why it was late (the app being off is not
 * proven by a past time).
 */
export function lateReminderText(r: Pick<Routine, 'name' | 'prompt'>): string {
  const due = dueOfOneShot(r.name);
  const when = due
    ? ((w) => `${pad2(w.day)}/${pad2(w.month)} ${pad2(w.hour)}:${pad2(w.minute)}`)(wallClock(due))
    : 'una hora anterior';
  return `⏰ Recordatorio pendiente con retraso (era para el ${when}): ${reminderText(r)}`;
}

/** Whether a fired one-shot is still stored. A job whose routine was deleted must not send again. */
export function oneShotStillPending(
  store: Pick<Store, 'getRoutine'>,
  routine: Pick<Routine, 'scope' | 'name'>,
): boolean {
  return store.getRoutine(routine.scope, routine.name) !== null;
}

export interface MissedDeliveryDeps {
  store: Pick<Store, 'listRoutines' | 'deleteRoutine'>;
  /**
   * Sends into the chat of the routine's scope; false when it could not be delivered.
   * `reminder` is the reminder's own text (for the «✅ Hecho» / «⏰ +1h» buttons).
   */
  send: (scope: string, text: string, reminder: string) => Promise<boolean>;
  now?: number;
}

/**
 * Startup catch-up: tell the user about every overdue one-time reminder, then delete
 * it. Delivery is AT LEAST ONCE, not exactly once: a send that errors or times out may
 * still have arrived, and a crash between the send and the delete repeats it at the
 * next start. A reminder whose send reported failure stays stored and is tried again
 * at the next start; a repeat of a reminder text is the accepted cost, and nothing
 * here promises a single delivery. Returns the counts.
 */
export async function deliverMissedReminders(
  deps: MissedDeliveryDeps,
): Promise<{ delivered: number; failed: number; invalid: number }> {
  const { missed, invalid } = missedOneShots(deps.store.listRoutines(), deps.now);
  let delivered = 0;
  let failed = 0;
  for (const r of missed) {
    const ok = await deps.send(r.scope, lateReminderText(r), reminderText(r)).catch(() => false);
    if (ok) {
      deps.store.deleteRoutine(r.scope, r.name);
      delivered++;
    } else {
      failed++;
    }
  }
  return { delivered, failed, invalid: invalid.length };
}

/** Last local day of a repeating reminder, kept at the end of its name (`... [cron] hasta YYYY-MM-DD`). */
export function untilOfReminder(name: string): string | null {
  const m = / hasta (\d{4}-\d{2}-\d{2})$/.exec(name);
  return m?.[1] ?? null;
}

/**
 * A repeating reminder with an end day is over when that day has passed, or when its
 * next firing after `now` falls after it (so it is removed right after its last one).
 */
export function reminderEnded(
  r: Pick<Routine, 'name' | 'schedule'>,
  now: Date = new Date(),
  afterFiring = false,
): boolean {
  const end = untilOfReminder(r.name);
  if (!end || isOneShotReminder(r)) return false;
  if (localDay(now) > end) return true;
  if (!afterFiring || !r.schedule) return false;
  const next = nextRunOf(r.schedule, now);
  return !next || localDay(next) > end;
}

function nextRunOf(schedule: string, from: Date): Date | null {
  try {
    return new Cron(schedule, { paused: true, timezone: localTimeZone() }).nextRun(from);
  } catch {
    return null;
  }
}

function nameFor(prefix: string, text: string, suffix = ''): string {
  return `${prefix} ${text.replace(/\s+/g, ' ').slice(0, 60)}${suffix}`.trim();
}

/** Cuánto vale un botón «✅ Hecho» / «⏰ +1h» de un aviso. */
export const FIRED_BUTTON_MS = 24 * 3_600_000;
/** Aviso de un botón de recordatorio caducado, ya usado o de antes de reiniciar. */
export const FIRED_BUTTON_STALE =
  'Este botón ya no sirve (vale una vez y 24 horas). Mira /recordatorios.';

/**
 * Recordatorios que acaban de avisar, para sus botones «✅ Hecho», «⏰ +1h» y «🌅 Mañana
 * 9:00». Un recordatorio puntual se borra al avisar, así que el botón lleva un id corto
 * que apunta aquí (OneTapIds). Con `file` sobrevive a un reinicio; sin él, tras
 * reiniciar el botón contesta FIRED_BUTTON_STALE.
 */
export class FiredReminders {
  readonly #ids: OneTapIds<{ scope: string; text: string }>;

  constructor(now: () => number = Date.now, max = 200, file?: string) {
    this.#ids = new OneTapIds({ ttlMs: FIRED_BUTTON_MS, now, max, file });
  }

  /** Apunta un aviso y devuelve su id (8 hex). Tira los caducados y, si sobran, los más viejos. */
  remember(scope: string, text: string): string {
    return this.#ids.remember({ scope, text });
  }

  /** Lo saca (un botón vale una vez). Solo desde el chat del aviso; caducado → undefined. */
  take(
    id: string,
    sameChat: (scope: string) => boolean,
  ): { scope: string; text: string } | undefined {
    const v = this.#ids.take(id, (e) => typeof e?.scope === 'string' && sameChat(e.scope));
    return v && typeof v.text === 'string' ? { scope: v.scope, text: v.text } : undefined;
  }
}

/**
 * «Mañana a las 9» en la hora de pared de PA_TIMEZONE (cambios de hora incluidos). De
 * madrugada (antes de las 5) «mañana» es hoy a las 9, como lo diría una persona.
 */
export function nextMorningAt9(now: number, timeZone: string = localTimeZone()): number {
  const w = wallClock(new Date(now), timeZone);
  return zonedTime(w.year, w.month, w.hour < 5 ? w.day : w.day + 1, 9, 0, timeZone);
}

/**
 * `/recordatorios hecho|pospone|manana <id>` (los botones del aviso). «Mañana 9:00» es
 * como «+1h» pero para mañana a las 9 (nextMorningAt9). «Hecho» solo lo da por
 * visto: no borra nada (un recordatorio que se repite sigue). «+1h» crea un recordatorio
 * puntual con el mismo texto dentro de una hora, en el mismo hilo. Devuelve la respuesta.
 */
export function reminderButtonCommand(
  deps: {
    fired: FiredReminders;
    store: Pick<Store, 'saveRoutine' | 'listRoutines'>;
    sameChat: (scope: string) => boolean;
    now?: () => number;
  },
  sub: 'hecho' | 'pospone' | 'manana',
  id: string,
): string {
  const hit = deps.fired.take(id, deps.sameChat);
  if (!hit) return FIRED_BUTTON_STALE;
  if (sub === 'hecho') return `✅ Hecho: ${hit.text}`;
  if (deps.store.listRoutines(hit.scope).filter(isReminder).length >= MAX_REMINDERS_PER_CHAT) {
    return `Ya hay ${MAX_REMINDERS_PER_CHAT} recordatorios en este chat: cancela alguno antes.`;
  }
  const t = (deps.now ?? Date.now)();
  const when = new Date(sub === 'manana' ? nextMorningAt9(t) : t + 3_600_000);
  deps.store.saveRoutine({
    scope: hit.scope,
    name: nameFor(REMINDER_ONCE_PREFIX, hit.text, ` @${stamp(when)}`),
    kind: 'schedule',
    prompt: hit.text,
    schedule: onceCron(when),
  });
  if (sub === 'manana') {
    const w = stamp(when);
    const day = `${w.slice(8, 10)}/${w.slice(5, 7)}`;
    const label = w.slice(0, 10) === stamp(new Date(t)).slice(0, 10) ? 'hoy' : 'mañana';
    return `🌅 Te lo vuelvo a recordar ${label} (${day}) a las ${w.slice(11)}: ${hit.text}`;
  }
  return `⏰ Te lo vuelvo a recordar a las ${stamp(when).slice(11)}: ${hit.text}`;
}

export function createReminderTool(deps: ReminderDeps): AgentTool<typeof Params> {
  const now = deps.now ?? (() => Date.now());
  return {
    name: 'reminder',
    label: 'Reminder',
    description: [
      'Reminders the user asked for: a message in this chat at the time they said.',
      'action=create with text plus ONE of: at (YYYY-MM-DDTHH:MM local), in_minutes (>= 2),',
      'or schedule (5-field cron, for repeating ones like every Monday 8:30; add until',
      '(YYYY-MM-DD, last day) when it should stop).',
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
          const end = untilOfReminder(r.name);
          const kind = isOneShotReminder(r)
            ? 'una vez'
            : `repite (${r.schedule})${end ? ` hasta ${end}` : ''}`;
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

      const until = args.until === undefined ? undefined : String(args.until).trim();
      if (until !== undefined) {
        if (args.schedule === undefined) {
          return reply('until solo vale con schedule (recordatorios que se repiten).', true);
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || !parseLocalStamp(`${until}T12:00`)) {
          return reply('until debe ser YYYY-MM-DD (último día, fecha real).', true);
        }
        if (until < localDay(new Date(now()))) {
          return reply(`El último día (${until}) ya pasó; dime otra fecha.`, true);
        }
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
        if (until !== undefined) {
          const first = nextRunOf(args.schedule.trim(), new Date(now()));
          if (!first || localDay(first) > until) {
            return reply(`No sonaría ninguna vez antes de que acabe el ${until}.`, true);
          }
        }
        const end = until ? ` hasta ${until}` : '';
        deps.store.saveRoutine({
          scope,
          name: nameFor(REMINDER_PREFIX, text, ` [${args.schedule.trim()}]${end}`),
          kind: 'schedule',
          prompt: text,
          schedule: args.schedule.trim(),
        });
        deps.sync();
        return reply(
          `Recordatorio programado (repite ${args.schedule.trim()}${end}): ${text}. Próximo: ${check.next}.`,
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

/**
 * A one-time reminder that could not be delivered for an hour is dropped (see
 * settleOneShot). The drop used to leave only a log line, so the user never learned that
 * "avísame a las 9" had not happened. It is written down here and /estado shows it.
 */
export function recordDroppedReminder(
  file: string,
  routineName: string,
  now = Date.now(),
  chat?: string,
): void {
  const due = dueOfOneShot(routineName);
  const label = routineName
    .replace(REMINDER_ONCE_PREFIX, '')
    .replace(/@\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '')
    .trim()
    .slice(0, 120);
  const when = due
    ? ((w) =>
        ` (era para el ${w.day}/${w.month} a las ${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')})`)(
        wallClock(due),
      )
    : '';
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(
      file,
      `${JSON.stringify({ at: now, text: `${label}${when}`, ...(chat ? { chat } : {}) })}\n`,
      'utf8',
    );
  } catch {
    // The drop is already logged; failing to note it must not break the scheduler.
  }
}

/** Dropped reminders from the last `days` days, newest last, at most `max`. */
export function readDroppedReminders(file: string, now = Date.now(), days = 7, max = 5): string[] {
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    try {
      const r = JSON.parse(line) as { at?: number; text?: string };
      if (typeof r.at === 'number' && typeof r.text === 'string' && now - r.at <= days * 86_400_000)
        out.push(r.text);
    } catch {
      // half-written line
    }
  }
  return out.slice(-max);
}

// ---------------------------------------------------------------------------
// /recordatorios: ver y borrar recordatorios desde Telegram sin pasar por el modelo.

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

/** «vie 31/10 09:00», en hora local. */
export function fechaCortaEs(d: Date): string {
  const w = wallClock(d);
  return `${DIAS[w.weekday]} ${pad(w.day)}/${pad(w.month)} ${pad(w.hour)}:${pad(w.minute)}`;
}

/** «en 5 min», «en 3 h 10 min», «en 2 d». */
export function dentroDeEs(ms: number): string {
  if (!(ms >= 60_000)) return 'en menos de 1 min';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `en ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `en ${h} h ${min % 60} min` : `en ${h} h`;
  return `en ${Math.round(h / 24)} d`;
}

export interface ReminderRow {
  routine: Routine;
  next: Date | null;
}

/**
 * Recordatorios del ámbito ordenados por la próxima vez que suenan (los que no
 * tienen próxima ejecución, al final). El número de /recordatorios es la
 * posición en esta lista.
 */
export function reminderRows(
  routines: Routine[],
  nextOf: (r: Routine) => Date | null = (r) => (r.schedule ? nextScheduleRun(r.schedule) : null),
): ReminderRow[] {
  return routines
    .filter(isReminder)
    .map((routine) => ({ routine, next: nextOf(routine) }))
    .sort((a, b) => {
      if (a.next && b.next) return a.next.getTime() - b.next.getTime();
      if (a.next) return -1;
      if (b.next) return 1;
      return reminderText(a.routine).localeCompare(reminderText(b.routine));
    });
}

export function formatReminderRows(rows: ReminderRow[], now: Date = new Date()): string {
  if (rows.length === 0) {
    return 'No tienes recordatorios. Pídemelos en lenguaje normal: «recuérdame mañana a las 9 llamar al dentista».';
  }
  const lines = rows.map(({ routine, next }, i) => {
    const when = next
      ? `${fechaCortaEs(next)} (${dentroDeEs(next.getTime() - now.getTime())})`
      : 'sin próxima vez';
    const kind = isOneShotReminder(routine) ? '' : ` · se repite (${routine.schedule})`;
    return `${i + 1}. ${reminderText(routine)} — ${when}${kind}`;
  });
  return [
    `Recordatorios: ${rows.length}`,
    ...lines,
    '',
    'Para borrar uno: /recordatorios borrar <número o palabra>',
  ].join('\n');
}

/**
 * Qué recordatorio quiere borrar el usuario: un número de la lista o una
 * palabra que aparezca en un solo recordatorio. Nunca borra si hay duda.
 */
export function pickReminder(
  rows: ReminderRow[],
  ref: string,
): { ok: true; routine: Routine } | { ok: false; error: string } {
  const want = ref.trim();
  if (!want) return { ok: false, error: 'Dime cuál: /recordatorios borrar <número o palabra>' };
  if (/^\d+$/.test(want)) {
    const row = rows[Number(want) - 1];
    if (!row) {
      return {
        ok: false,
        error: rows.length
          ? `No hay recordatorio ${want}: elige entre 1 y ${rows.length}.`
          : 'No tienes recordatorios.',
      };
    }
    return { ok: true, routine: row.routine };
  }
  const needle = want.toLowerCase();
  const hits = rows.filter((r) => reminderText(r.routine).toLowerCase().includes(needle));
  if (hits.length === 0)
    return { ok: false, error: `No encuentro ningún recordatorio con «${want}».` };
  if (hits.length > 1) {
    const options = hits.map((h) => `${rows.indexOf(h) + 1}. ${reminderText(h.routine)}`);
    return {
      ok: false,
      error: [`Hay ${hits.length} con «${want}». Bórralo por número:`, ...options].join('\n'),
    };
  }
  return { ok: true, routine: (hits[0] as ReminderRow).routine };
}
