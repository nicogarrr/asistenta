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
