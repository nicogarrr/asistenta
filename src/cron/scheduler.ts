/**
 * Schedules recurring prompts and turns natural language into a cron expression.
 *
 * This exists because "resúmeme el día cada mañana a las 8" is how a person asks for a
 * recurring job, and a cron expression is how a scheduler takes one. A user who has to
 * write `0 8 * * *` will simply not use the feature, so the translation lives here and
 * the expression is the internal representation.
 *
 * `setTimeout` chained rather than `setInterval`: an interval fires on a fixed schedule
 * regardless of whether the previous job finished, so a job that takes longer than its
 * period piles up. A chain waits for the work before scheduling the next tick.
 *
 * The clock is injected. A scheduler that reads the real clock cannot be tested without
 * waiting for wall-clock minutes, which makes the tests slow and flaky; with a fake
 * clock a whole day of schedules runs in milliseconds.
 *
 * Times are local wall-clock, matching how `croner` reads the same expressions for
 * `RoutineRunner`. Interpreting the fields in UTC would fire `0 8 * * *` at 08:00 UTC —
 * 10:00 in Madrid during summer — while the routine it mirrors fired at 08:00 local, so
 * `/agenda` and the real scheduler would disagree about what the user asked for.
 *
 * A job is bound to a local wall-clock time, not to an instant, so a daylight saving
 * change must neither duplicate nor lose a firing:
 * - When that wall time does not exist (the clock jumps 02:00 → 03:00), `new Date`
 *   normalises 02:30 to 03:30 and the job runs there, once, instead of silently
 *   skipping the day. A job must never just vanish.
 * - When the wall time exists twice (03:00 → 02:00), `new Date` picks the first
 *   occurrence and the job runs there, once; the repeated hour is not a second slot.
 * - When two slots normalise onto the same instant (02:00 and 03:00 on a 02:00 → 03:00
 *   day), the job runs once at that instant. Running twice would punish the user for a
 *   clock change they did not schedule.
 */

export interface CronJob {
  id: string;
  /** 5 fields (m h dom mon dow) or 6 with seconds. */
  schedule: string;
  /** What the agent should do when it fires. */
  prompt: string;
  /** Where the result is delivered. */
  chatId: string;
  threadKey?: string;
}

export interface ScheduledJob extends CronJob {
  nextRun: number | null;
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

/** How often the scheduler wakes up to see whether anything is due. */
const TICK_MS = 30 * SECOND_MS;

/**
 * Floor on the tick. Not `SECOND_MS`: a test with a fake clock wants a sub-second tick
 * to avoid waiting for wall-clock minutes, and clamping it to a second turns a 300ms
 * test into a silent no-op that looks like the scheduler never fires.
 */
const MIN_TICK_MS = 25;

/** 0-6, Sunday = 0, matching cron's convention rather than Date.getDay()'s. */
function cronDayOfWeek(date: Date): number {
  // Local, not UTC: the day-of-week cron names is the one the user sees on their
  // calendar. (The numeric convention still matches Date.getDay().)
  return date.getDay();
}

function parseField(raw: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const piece = part.trim();
    if (!piece) return null;

    const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(piece);
    if (stepMatch) {
      const base = stepMatch[1] ?? '';
      const step = Number(stepMatch[2] ?? 1);
      if (!Number.isInteger(step) || step <= 0) return null;
      const from = base === '*' ? min : Number((base.split('-')[0] ?? '').trim());
      const to =
        base === '*' ? max : Number((base.split('-')[1] ?? base.split('-')[0] ?? '').trim());
      if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
      for (let v = from; v <= to; v += step) values.add(v);
      continue;
    }

    const rangeMatch = /^(\d+)-(\d+)$/.exec(piece);
    if (rangeMatch) {
      const from = Number(rangeMatch[1]);
      const to = Number(rangeMatch[2]);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) return null;
      for (let v = from; v <= to; v++) values.add(v);
      continue;
    }

    if (piece === '*') {
      for (let v = min; v <= max; v++) values.add(v);
      continue;
    }

    const n = Number(piece);
    if (!Number.isInteger(n)) return null;
    values.add(n);
  }

  for (const v of values) {
    if (v < min || v > max) return null;
  }
  return values.size ? [...values].sort((a, b) => a - b) : null;
}

interface ParsedSchedule {
  seconds: number[];
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

/**
 * Parse a cron expression into sets of allowed values.
 *
 * Six fields are accepted with a leading seconds field, five without. Both are common
 * enough that accepting only one would be a support ticket rather than a design. The
 * values are local wall-clock values: they are matched against local dates and times,
 * never against UTC.
 */
export function parseCronExpression(expr: string): ParsedSchedule | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return null;

  const hasSeconds = fields.length === 6;
  const secondField = (hasSeconds ? fields[0] : '0') ?? '0';
  const minuteField = fields[hasSeconds ? 1 : 0] ?? '';
  const hourField = fields[hasSeconds ? 2 : 1] ?? '';
  const domField = fields[hasSeconds ? 3 : 2] ?? '';
  const monthField = fields[hasSeconds ? 4 : 3] ?? '';
  const dowField = fields[hasSeconds ? 5 : 4] ?? '';

  const seconds = parseField(secondField, 0, 59);
  const minutes = parseField(minuteField, 0, 59);
  const hours = parseField(hourField, 0, 23);
  const daysOfMonth = parseField(domField, 1, 31);
  const months = parseField(monthField, 1, 12);
  const daysOfWeek = parseField(dowField, 0, 7);
  if (!seconds || !minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;

  // cron accepts 7 as an alias for Sunday; normalise so `dow === 7` and `dow === 0`
  // match the same day rather than being two separate values.
  const normalisedDow = new Set([...daysOfWeek].map((d) => (d === 7 ? 0 : d)));

  return {
    seconds,
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek: [...normalisedDow].sort((a, b) => a - b),
  };
}

/**
 * Whether the local clock changes inside this calendar day: a daylight saving jump or a
 * skipped midnight. On those days wall-clock order is not instant order — a nonexistent
 * 02:30 normalises to 03:30 while a real 03:15 stays at 03:15 — so candidates have to be
 * compared as instants instead of taken in scan order.
 */
function clockChangesDuring(year: number, month: number, day: number): boolean {
  const midnight = new Date(year, month, day, 0, 0, 0);
  const nextMidnight = new Date(year, month, day + 1, 0, 0, 0);
  return (
    midnight.getHours() !== 0 ||
    nextMidnight.getHours() !== 0 ||
    midnight.getTimezoneOffset() !== nextMidnight.getTimezoneOffset()
  );
}

/**
 * The earliest scheduled instant inside one local calendar day at or after `from`, or
 * null when the day has none.
 *
 * Candidates are built with the local `Date(y, m, d, h, min, s)` constructor so they are
 * wall-clock times in the user's zone. The DST normalisation that constructor performs
 * (documented at the top of this file) is what keeps a job from firing twice or not at
 * all when the clock changes.
 */
function firstRunOnDay(
  schedule: ParsedSchedule,
  year: number,
  month: number,
  day: number,
  from: number,
): number | null {
  const exact = clockChangesDuring(year, month, day);
  let best: number | null = null;
  for (const hour of schedule.hours) {
    for (const minute of schedule.minutes) {
      for (const second of schedule.seconds) {
        const candidate = new Date(year, month, day, hour, minute, second).getTime();
        if (candidate < from) continue;
        // On an ordinary day the scan is already in chronological order, so the first
        // hit is the earliest and the loop can stop. Around a clock change the
        // normalised times can be out of order, so every candidate is priced and the
        // smallest wins: whichever slot the day offers first is the one that runs.
        if (!exact) return candidate;
        if (best === null || candidate < best) best = candidate;
      }
    }
  }
  return best;
}

/**
 * The next time `schedule` matches at or after `from`, scanning day by day.
 *
 * Day granularity rather than minute: a cron entry is about when something happens in a
 * person's day, and the per-day slot sets are tiny, so pricing the candidates of a
 * matching day is cheaper and clearer than walking 1440 minutes to reach them. The
 * search stops after at most 366 days, which is what a yearly job needs.
 */
export function nextCronRun(schedule: ParsedSchedule, from: number): number | null {
  const start = new Date(from);
  let year = start.getFullYear();
  let month = start.getMonth();
  let day = start.getDate();
  const limit = from + 366 * 24 * 60 * MINUTE_MS;

  for (let scanned = 0; scanned <= 366; scanned++) {
    // Noon anchors the day, not midnight: a few zones skip midnight on a DST day and
    // normalise it into the next one, which would drop a day from the scan. Noon is
    // never skipped, and its weekday is the weekday of the whole day.
    const noon = new Date(year, month, day, 12, 0, 0);
    if (noon.getTime() > limit) return null;
    if (
      schedule.months.includes(month + 1) &&
      schedule.daysOfMonth.includes(day) &&
      schedule.daysOfWeek.includes(cronDayOfWeek(noon))
    ) {
      const hit = firstRunOnDay(schedule, year, month, day, from);
      if (hit !== null) return hit;
    }
    const nextNoon = new Date(year, month, day + 1, 12, 0, 0);
    year = nextNoon.getFullYear();
    month = nextNoon.getMonth();
    day = nextNoon.getDate();
  }
  return null;
}

/**
 * Turn an ordinary Spanish sentence into a schedule.
 *
 * The patterns cover what people actually say about a recurring job: a time of day, a
 * day of the week, an interval. Anything without one of those is not a schedule and
 * returns null, so a caller can fall back to asking rather than guessing at 3 a.m.
 */
export function parseNatural(text: string): { schedule: string; prompt: string } | null {
  const normalised = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // A time of day is the strongest signal. `a las 8`, `a las 8:30`, `a las 20h`.
  let hour = 0;
  let minute = 0;
  let hasTime = false;

  const timeMatch = /\ba las?\s+(\d{1,2})(?::(\d{2}))?\s*(h|hs|horas?)?\b/.exec(normalised);
  if (timeMatch) {
    hour = Number(timeMatch[1] ?? 0);
    minute = Number(timeMatch[2] ?? 0);
    hasTime = true;
    // "a las 6 por la tarde" means six in the evening to a person, and a scheduler that
    // fires at 6 a.m. instead is the kind of bug that makes people stop using it. The
    // modifier is matched anywhere in the sentence, not only after the time.
    if (/(tarde|noche)/.test(normalised) && hour < 12) {
      hour += 12;
    }
  } else if (/cada manana/.test(normalised)) {
    hour = 8;
    hasTime = true;
  } else if (/cada tarde/.test(normalised)) {
    hour = 18;
    hasTime = true;
  } else if (/cada noche/.test(normalised)) {
    hour = 22;
    hasTime = true;
  }

  if (hour > 23 || minute > 59) return null;

  // Intervals beat fixed times: "cada 5 minutos" is a schedule on its own.
  const everyN = /cada (\d{1,3}) (minutos?|horas?)/.exec(normalised);
  if (everyN) {
    const n = Number(everyN[1]);
    if (!Number.isInteger(n) || n <= 0) return null;
    const unit = everyN[2] ?? '';
    const schedule = unit.startsWith('minuto') ? `*/${n} * * * *` : `0 */${n} * * *`;
    return { schedule, prompt: text.trim() };
  }
  if (/cada hora\b/.test(normalised)) return { schedule: '0 * * * *', prompt: text.trim() };
  if (/cada dia|todos los dias|diariamente/.test(normalised) && !hasTime) {
    return { schedule: '0 8 * * *', prompt: text.trim() };
  }

  const dayMap: Array<[RegExp, number]> = [
    [/los lunes|cada lunes/, 1],
    [/los martes|cada martes/, 2],
    [/los miercoles|cada miercoles/, 3],
    [/los jueves|cada jueves/, 4],
    [/los viernes|cada viernes/, 5],
    [/los sabados|cada sabado/, 6],
    [/los domingos|cada domingo/, 0],
  ];
  for (const [pattern, dow] of dayMap) {
    if (pattern.test(normalised)) {
      return {
        schedule: `${minute} ${hour} * * ${dow}`,
        prompt: text.trim(),
      };
    }
  }

  if (/cada semana|semanalmente/.test(normalised) && hasTime) {
    return { schedule: `${minute} ${hour} * * 1`, prompt: text.trim() };
  }

  if (hasTime) return { schedule: `${minute} ${hour} * * *`, prompt: text.trim() };
  return null;
}

export interface PromptCronOptions {
  jobs: CronJob[];
  run: (job: CronJob) => Promise<void>;
  now?: () => number;
  /** How often to look for a due job. */
  tickMs?: number;
}

export class PromptCron {
  readonly #jobs = new Map<string, CronJob>();
  readonly #parsed = new Map<string, ParsedSchedule | null>();
  readonly #run: (job: CronJob) => Promise<void>;
  readonly #now: () => number;
  readonly #tickMs: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Jobs fired in this minute, so a slow tick cannot fire the same job twice. */
  #firedAt = new Map<string, number>();

  constructor(options: PromptCronOptions) {
    this.#run = options.run;
    this.#now = options.now ?? Date.now;
    this.#tickMs = Math.max(MIN_TICK_MS, options.tickMs ?? TICK_MS);
    for (const job of options.jobs) {
      this.#jobs.set(job.id, job);
      this.#parsed.set(job.id, parseCronExpression(job.schedule));
    }
  }

  start(): void {
    if (this.#timer) return;
    const tick = (): void => {
      if (!this.#timer) return;
      void this.#check().finally(() => {
        if (!this.#timer) return;
        this.#timer = setTimeout(tick, this.#tickMs);
        this.#timer.unref?.();
      });
    };
    this.#timer = setTimeout(tick, this.#tickMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#firedAt.clear();
  }

  /** Fire every job whose minute is now and has not fired yet this minute. */
  async #check(): Promise<void> {
    const now = this.#now();
    const minute = Math.floor(now / MINUTE_MS);
    for (const job of this.#jobs.values()) {
      const schedule = this.#parsed.get(job.id);
      if (!schedule) continue;
      const next = nextCronRun(schedule, now - MINUTE_MS);
      if (next === null) continue;
      // Only fire when the next run is inside the minute we are in and has already
      // been reached: anything later is the future (a slot at :30 must not fire on
      // the first tick of the minute), anything earlier already fired in a previous
      // tick.
      if (Math.floor(next / MINUTE_MS) !== minute) continue;
      if (next > now) continue;
      if (this.#firedAt.get(job.id) === minute) continue;
      this.#firedAt.set(job.id, minute);
      try {
        await this.#run(job);
      } catch {
        // A failing job must not stop the scheduler: the next one is still wanted.
      }
    }
    // Bound the dedup map: a daemon that runs for weeks would otherwise grow one entry
    // per job per minute.
    if (this.#firedAt.size > 500) this.#firedAt.clear();
  }

  nextRun(id: string): Date | null {
    const schedule = this.#parsed.get(id);
    if (!schedule) return null;
    const at = nextCronRun(schedule, this.#now());
    return at === null ? null : new Date(at);
  }

  list(): ScheduledJob[] {
    return [...this.#jobs.values()].map((job) => ({
      ...job,
      nextRun: this.nextRun(job.id)?.getTime() ?? null,
    }));
  }

  get size(): number {
    return this.#jobs.size;
  }
}
