import { foldAccents } from '../text.js';
/**
 * Turns how a person asks for a recurring job («resúmeme el día cada mañana a las 8»)
 * into a 5-field cron expression. A user who has to write `0 8 * * *` will simply not
 * use the feature, so the translation lives here and the expression is the internal
 * representation.
 *
 * Firing is NOT done here: routines (and reminders, goals) are scheduled by `croner` in
 * `RoutineRunner` (src/routines.ts), in local wall-clock time. This module used to carry
 * its own scheduler (`PromptCron` + a cron engine); the daemon never used it, so it was
 * removed (30-oct-2026) to keep one scheduler only.
 */

/**
 * Argument of the "/cron add" command: either a literal cron spec and the task
 * split by "|", or the whole thing in natural language for `parseNatural`.
 * Pure on purpose, with the validator injected: the command's canaries
 * exercise it without a chat, and this module stays free of routines.ts.
 */
export function parseCronAdd(
  body: string,
  validate: (expr: string) => { ok: true; next: string } | { ok: false; error: string },
): { ok: true; schedule: string; prompt: string } | { ok: false; error: string } {
  const pipe = body.indexOf('|');
  if (pipe >= 0) {
    const schedule = body.slice(0, pipe).trim();
    const prompt = body.slice(pipe + 1).trim();
    if (!schedule || !prompt) {
      return {
        ok: false,
        error: 'Faltan el horario o la tarea. Formato: /cron add 0 8 * * * | resumen del día',
      };
    }
    const check = validate(schedule);
    if (!check.ok) return { ok: false, error: `Ese horario no vale: ${check.error}` };
    return { ok: true, schedule, prompt };
  }
  const parsed = parseNatural(body);
  if (!parsed) {
    return {
      ok: false,
      error:
        'No entiendo ese horario. Prueba "/cron add 0 8 * * * | tarea" o "/cron add cada mañana a las 8 tarea".',
    };
  }
  // The natural branch is heuristic output, so it goes through the SAME
  // validator as the literal branch before anything can be persisted
  // (auditor #135 ronda 2: "cada999minutos" must never reach saveRoutine).
  const naturalCheck = validate(parsed.schedule);
  if (!naturalCheck.ok) return { ok: false, error: `Ese horario no vale: ${naturalCheck.error}` };
  return { ok: true, schedule: parsed.schedule, prompt: parsed.prompt };
}

/** «a la una», «a las doce»: hours people say in words. */
const SPOKEN_HOUR_VALUE: Record<string, number> = {
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
};
const SPOKEN_HOURS = Object.keys(SPOKEN_HOUR_VALUE).join('|');

/** A clock hour with the part of the day said next to it, in 24h. */
function withPartOfDay(hour: number, part: string): number {
  if (part === 'manana' || part === 'madrugada') return hour === 12 ? 0 : hour;
  if (part === 'tarde') return hour >= 1 && hour < 12 ? hour + 12 : hour;
  // «de la noche»: 12 is midnight, 1-4 are the small hours, 5-11 the evening.
  if (hour === 12) return 0;
  if (hour >= 5 && hour < 12) return hour + 12;
  return hour;
}

/**
 * Turn an ordinary Spanish sentence into a schedule.
 *
 * The patterns cover what people actually say about a recurring job: a time of day, a
 * day of the week, an interval. Anything without one of those is not a schedule and
 * returns null, so a caller can fall back to asking rather than guessing at 3 a.m.
 */
export function parseNatural(text: string): { schedule: string; prompt: string } | null {
  const normalised = foldAccents(text).replace(/\s+/g, ' ').trim();

  // A time of day is the strongest signal. `a las 8`, `a las 8:30`, `a las 20h`.
  let hour = 0;
  let minute = 0;
  let hasTime = false;

  const timeMatch = new RegExp(
    `\\ba las?\\s+(\\d{1,2}|${SPOKEN_HOURS})(?:[:.h](\\d{2}))?(?:\\s+y\\s+(media|cuarto)|\\s+menos\\s+(cuarto))?\\s*(h|hs|horas?)?\\b(?:\\s*(?:de|por) la (manana|madrugada|tarde|noche))?`,
  ).exec(normalised);
  if (timeMatch) {
    const said = timeMatch[1] ?? '0';
    hour = /^\d+$/.test(said) ? Number(said) : (SPOKEN_HOUR_VALUE[said] ?? 0);
    minute = Number(timeMatch[2] ?? 0);
    // «a las 8 y media», «a las 9 menos cuarto»: before, the half hour was dropped.
    if (timeMatch[3] === 'media') minute = 30;
    else if (timeMatch[3] === 'cuarto') minute = 15;
    else if (timeMatch[4]) {
      hour = hour === 0 ? 23 : hour - 1;
      minute = 45;
    }
    hasTime = true;
    const part = timeMatch[6];
    if (part) {
      // The part of the day said right next to the clock is the one that counts:
      // «a las 12 de la noche» is midnight and «a la una de la noche» is 01:00, not
      // noon and 13:00; «a las 8 de la mañana … esta noche» stays at 8.
      hour = withPartOfDay(hour, part);
    } else if (/(tarde|noche)/.test(normalised) && hour < 12) {
      // "a las 6 … por la tarde" means six in the evening to a person, and a scheduler
      // that fires at 6 a.m. instead is the kind of bug that makes people stop using it.
      // Without a part of day next to the clock, the modifier counts anywhere.
      hour += 12;
    }
  } else if (/\b(?:a )?medianoche\b/.test(normalised)) {
    hour = 0;
    hasTime = true;
  } else if (/\b(?:a(?:l)? )?mediodia\b/.test(normalised)) {
    hour = 12;
    hasTime = true;
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
