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
        error:
          'Faltan el horario o la tarea. Dime cuándo y qué, por ejemplo «cada mañana a las 8 el resumen del día».',
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
        'No entiendo ese horario. Dímelo de otra forma, por ejemplo «cada mañana a las 8 el resumen del día» o «cada lunes a las 9 revisar el correo».',
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

/** Minutes said in words after «y» / «menos»: «y diez», «menos veinte», «y treinta y cinco». */
const MINUTE_UNITS: Record<string, number> = {
  uno: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
};
const MINUTE_WORD_VALUE: Record<string, number> = {
  ...MINUTE_UNITS,
  diez: 10,
  once: 11,
  doce: 12,
  trece: 13,
  catorce: 14,
  quince: 15,
  dieciseis: 16,
  diecisiete: 17,
  dieciocho: 18,
  diecinueve: 19,
  veinte: 20,
  veintiuno: 21,
  veintidos: 22,
  veintitres: 23,
  veinticuatro: 24,
  veinticinco: 25,
  veintiseis: 26,
  veintisiete: 27,
  veintiocho: 28,
  veintinueve: 29,
  treinta: 30,
  cuarenta: 40,
  cincuenta: 50,
  cuarto: 15,
  media: 30,
};
for (const [tens, t] of [
  ['treinta', 30],
  ['cuarenta', 40],
  ['cincuenta', 50],
] as const) {
  for (const [unit, u] of Object.entries(MINUTE_UNITS))
    MINUTE_WORD_VALUE[`${tens} y ${unit}`] = t + u;
}
// Longest first, so «treinta y cinco» wins over «treinta».
export const MINUTES_AFTER = `\\d{1,2}|${Object.keys(MINUTE_WORD_VALUE)
  .sort((a, b) => b.length - a.length)
  .join('|')}`;
export const MINUTES_BEFORE = '\\d{1,2}|veinticinco|veinte|cuarto|cinco|diez';
/** «15» or «quince» → 15; anything else → NaN. */
export const minuteSaid = (said: string): number =>
  /^\d+$/.test(said) ? Number(said) : (MINUTE_WORD_VALUE[said] ?? Number.NaN);

/** A clock hour with the part of the day said next to it, in 24h. */
function withPartOfDay(hour: number, part: string): number {
  // «a las 12 de la mañana» es mediodía en España; «las 12 de la madrugada», medianoche.
  if (part === 'manana') return hour;
  if (part === 'madrugada') return hour === 12 ? 0 : hour;
  if (part === 'tarde') return hour >= 1 && hour < 12 ? hour + 12 : hour;
  // «de la noche»: 12 is midnight, 1-4 are the small hours, 5-11 the evening.
  if (hour === 12) return 0;
  if (hour >= 5 && hour < 12) return hour + 12;
  return hour;
}

const MONTH_NAMES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** Una hora dicha: «9», «8:30», «ocho y media», «9 menos cuarto», «7 de la tarde». */
const CLOCK = `(\\d{1,2}|${SPOKEN_HOURS})(?:[:.h](\\d{2}))?(?:\\s+y\\s+(${MINUTES_AFTER})|\\s+menos\\s+(${MINUTES_BEFORE}))?(?:\\s+en punto)?\\s*(h|hs|horas?)?\\b(?:\\s*(?:de|por) la (manana|madrugada|tarde|noche))?`;

/** Hora y minuto de una coincidencia de CLOCK, en 24 h; null si no es una hora real. */
function clockOf(m: RegExpExecArray): { hour: number; minute: number } | null {
  const said = m[1] ?? '0';
  let hour = /^\d+$/.test(said) ? Number(said) : (SPOKEN_HOUR_VALUE[said] ?? 0);
  let minute = Number(m[2] ?? 0);
  // «a las 8 y media», «a las ocho y diez», «a las 9 menos veinte»: before, the
  // minutes said in words were dropped and the routine fired on the hour.
  // «a las 8 y 15», «a las 9 menos 10» and «y treinta y cinco» too (gaps8).
  if (m[3]) minute = minuteSaid(m[3]);
  else if (m[4]) {
    const before = minuteSaid(m[4]);
    if (!(before >= 1 && before <= 30)) return null;
    hour = hour === 0 ? 23 : hour - 1;
    minute = 60 - before;
  }
  // The part of the day said right next to the clock is the one that counts:
  // «a las 12 de la noche» is midnight and «a la una de la noche» is 01:00, not
  // noon and 13:00; «a las 8 de la mañana … esta noche» stays at 8.
  if (m[6]) hour = withPartOfDay(hour, m[6]);
  return { hour, minute };
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

  const timeMatch = new RegExp(`\\ba las?\\s+${CLOCK}`).exec(normalised);
  /** «a las 9 y a las 21», «a las 8, 14 y 20»: más tomas del mismo día. */
  const extraHours: number[] = [];
  if (timeMatch) {
    const first = clockOf(timeMatch);
    if (!first) return null;
    hour = first.hour;
    minute = first.minute;
    hasTime = true;
    // Antes solo se leía la primera hora: «a las 9 y a las 21 pastilla» quedaba en
    // «0 9 * * *» y la toma de la noche se perdía sin avisar.
    let rest = normalised.slice(timeMatch.index + timeMatch[0].length);
    let list = false;
    const take = (m: RegExpExecArray): boolean => {
      const clock = clockOf(m);
      // Un cron solo pone varias horas con el mismo minuto; si no, se pregunta.
      if (!clock || clock.minute !== minute) return false;
      extraHours.push(clock.hour);
      rest = rest.slice(m[0].length);
      return true;
    };
    for (;;) {
      const named = new RegExp(`^(?:\\s*,\\s*|\\s*\\by\\s+)(?:a\\s+)?las?\\s+${CLOCK}`).exec(rest);
      // «, 14» sin «las» solo dentro de una lista que sigue («, 14 y 20»): «a las 8, 20
      // minutos de paseo» no es otra hora.
      const bare = named ? null : new RegExp(`^\\s*,\\s*${CLOCK}(?=\\s*,|\\s*\\by\\s)`).exec(rest);
      const m = named ?? bare;
      if (!m) break;
      if (!take(m)) return null;
      if (bare) list = true;
    }
    if (list) {
      const last = new RegExp(
        `^\\s*\\by\\s+${CLOCK}(?!\\s*(?:min|minutos?|veces|dias|semanas)\\b)`,
      ).exec(rest);
      if (last && !take(last)) return null;
    }
    // «a las 9 pastilla y a las 21 otra», «a las 7 riega y otra vez a las 8 de la tarde»:
    // la segunda hora llega más tarde en la frase. Antes se perdía (o, con «de la
    // tarde», movía la primera toma a la tarde); ahora cuenta como otra toma.
    for (const later of rest.matchAll(
      new RegExp(`\\by\\s+(?:otra(?:\\s+vez)?\\s+|tambien\\s+)?a\\s+las?\\s+${CLOCK}`, 'g'),
    )) {
      const clock = clockOf(later as RegExpExecArray);
      if (!clock || clock.minute !== minute) return null;
      extraHours.push(clock.hour);
    }
    const part = timeMatch[6];
    if (!part && extraHours.length === 0 && /(tarde|noche)/.test(normalised) && hour < 12) {
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

  if (!hasTime) {
    // A part of the day with no clock: «los sábados por la mañana», «cada día por la
    // tarde», «todas las mañanas». Before, the days ones fired at 00:00.
    const part = /\bpor la (manana|tarde|noche)\b|\btodas las (manana|tarde|noche)s\b/.exec(
      normalised,
    );
    const said = part?.[1] ?? part?.[2];
    if (said) {
      hour = said === 'manana' ? 8 : said === 'tarde' ? 18 : 22;
      hasTime = true;
    }
  }

  if (hour > 23 || !(minute >= 0 && minute <= 59)) return null;
  if (extraHours.some((h) => h > 23)) return null;
  // «9,21»: varias tomas al día con el mismo minuto.
  const hours = [...new Set([hour, ...extraHours])].sort((x, y) => x - y).join(',');

  // «cada 2 días», «cada dos semanas», «el último día de cada mes»: a cron cannot say
  // them simply. Before, they became «every day»; now the caller asks.
  if (/\bcada (?:\d{1,3}|[a-z]+) (?:dias|semanas|meses)\b/.test(normalised)) return null;
  if (/\bultimo dia\b/.test(normalised) && /\bmes(?:es)?\b/.test(normalised)) return null;

  // «cada 25 de diciembre», «todos los años el 6 de enero»: una vez al año. Antes una
  // fecha del año (o «cada año», «cada trimestre», «una vez al mes») caía en «todos
  // los días» a esa hora; ahora la fecha se respeta y lo que un cron no dice se pregunta.
  const daily = /\b(?:cada dia|todos los dias|diariamente)\b(?! \d)/.test(normalised);
  const ofYear = new RegExp(String.raw`\b(\d{1,2}) de (${MONTH_NAMES.join('|')})\b`).exec(
    normalised,
  );
  const yearly =
    /\b(?:todos los anos|cada ano|anualmente)\b/.test(normalised) ||
    (ofYear !== null && normalised.slice(0, ofYear.index).endsWith('cada '));
  if (ofYear && yearly && !daily) {
    const day = Number(ofYear[1]);
    const month = MONTH_NAMES.indexOf(ofYear[2] ?? '') + 1;
    // El año 2000 fue bisiesto: así «cada 29 de febrero» vale y «cada 31 de febrero» no.
    const real = new Date(Date.UTC(2000, month - 1, day)).getUTCDate() === day;
    if (!real) return null;
    return { schedule: `${minute} ${hasTime ? hours : 8} ${day} ${month} *`, prompt: text.trim() };
  }
  if (
    /\b(?:cada|una vez al|una vez cada) (?:ano|quincena|trimestre|semestre)\b|\buna vez al mes\b|\b(?:quincenal|trimestral|semestral)mente\b/.test(
      normalised,
    )
  ) {
    return null;
  }
  // «cada día 5 a las 9»: el día 5 de cada mes, no todos los días.
  const dayEachMonth = /\bcada dia (\d{1,2})\b(?! (?:veces|minutos?|min|horas?))/.exec(normalised);
  if (dayEachMonth) {
    const day = Number(dayEachMonth[1]);
    if (day < 1 || day > 31) return null;
    return { schedule: `${minute} ${hasTime ? hours : 8} ${day} * *`, prompt: text.trim() };
  }

  // «cada mes el día 5», «el día 1 de cada mes», «todos los meses el 15».
  if (/\b(?:cada mes|todos los meses|de cada mes|mensualmente)\b/.test(normalised)) {
    const rest = normalised.replace(/\ba las? \S+/, '');
    const said =
      /\bel (?:dia )?(\d{1,2}|primero)\b/.exec(rest)?.[1] ??
      /\b(\d{1,2}) de cada mes\b/.exec(rest)?.[1] ??
      (/\bel primer dia\b/.test(rest) ? '1' : undefined);
    const day = said === undefined ? Number.NaN : said === 'primero' ? 1 : Number(said);
    if (!Number.isInteger(day) || day < 1 || day > 31) return null;
    return { schedule: `${minute} ${hasTime ? hours : 8} ${day} * *`, prompt: text.trim() };
  }

  // Intervals beat fixed times: "cada 5 minutos" is a schedule on its own.
  // «cada media hora», «cada cuarto de hora», «cada dos horas», «cada 30 min».
  if (/\bcada media hora\b/.test(normalised))
    return { schedule: '*/30 * * * *', prompt: text.trim() };
  if (/\bcada cuarto de hora\b/.test(normalised)) {
    return { schedule: '*/15 * * * *', prompt: text.trim() };
  }
  const everyN = new RegExp(`cada (\\d{1,3}|${INTERVAL_WORDS}) (minutos?|min|horas?)\\b`).exec(
    normalised,
  );
  if (everyN) {
    const n = /^\d+$/.test(everyN[1] ?? '')
      ? Number(everyN[1])
      : (INTERVAL_WORD_VALUE[everyN[1] ?? ''] ?? 0);
    if (!Number.isInteger(n) || n <= 0) return null;
    const unit = everyN[2] ?? '';
    // A cron step restarts every hour (minutes) or every day (hours): «*/45» fires at
    // :00 and :45, so «cada 45 minutos» would come 45 and then 15 minutes apart, and
    // «cada 7 horas» at 0, 7, 14 and 21. Only steps that divide evenly are honest;
    // «cada 120 minutos» is «cada 2 horas». The rest are asked, like «cada 2 días».
    const hours = unit.startsWith('min') ? n / 60 : n;
    if (unit.startsWith('min') && 60 % n === 0) {
      return { schedule: `*/${n} * * * *`, prompt: text.trim() };
    }
    if (!Number.isInteger(hours) || 24 % hours !== 0) return null;
    const schedule = hours === 24 ? '0 0 * * *' : `0 */${hours} * * *`;
    return { schedule, prompt: text.trim() };
  }
  if (/cada hora\b/.test(normalised)) return { schedule: '0 * * * *', prompt: text.trim() };
  if (/cada dia|todos los dias|diariamente/.test(normalised) && !hasTime) {
    return { schedule: '0 8 * * *', prompt: text.trim() };
  }

  // «los lunes y miércoles», «de lunes a viernes», «los fines de semana». With no
  // clock a day job fires at 8, like «cada día»: before, «los lunes» fired at 00:00.
  const dow = daysOfWeek(normalised);
  if (dow !== null) {
    return {
      schedule: `${minute} ${hasTime ? hours : 8} * * ${dow}`,
      prompt: text.trim(),
    };
  }

  if (/cada semana|semanalmente/.test(normalised) && hasTime) {
    return { schedule: `${minute} ${hours} * * 1`, prompt: text.trim() };
  }

  // «el 6 de enero a las 9» sin «cada año» es un día suelto, no todos los días.
  if (ofYear && !daily) return null;
  if (hasTime) return { schedule: `${minute} ${hours} * * *`, prompt: text.trim() };
  return null;
}

const DAY_VALUE: Record<string, number> = {
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  sabados: 6,
  domingo: 0,
  domingos: 0,
};
const DAY = 'lunes|martes|miercoles|jueves|viernes|sabados?|domingos?';

/** The cron day-of-week field for the days said, or null when no day is said. */
function daysOfWeek(normalised: string): string | null {
  if (/\b(?:entre semana|(?:los )?dias laborables|de lunes a viernes)\b/.test(normalised)) {
    return '1-5';
  }
  if (/\b(?:los|cada|el) fin(?:es)? de semana\b/.test(normalised)) return '0,6';
  const range = new RegExp(`\\bde (${DAY}) a (${DAY})\\b`).exec(normalised);
  const from = DAY_VALUE[range?.[1] ?? ''];
  const to = DAY_VALUE[range?.[2] ?? ''];
  if (from !== undefined && to !== undefined && from !== to) {
    if (to > from) return `${from}-${to}`;
    // «de viernes a lunes», «de sábado a lunes»: the range goes round the weekend.
    // Before, it was not read at all and the job fired every day.
    const days: number[] = [];
    for (let d = from; d !== to; d = (d + 1) % 7) days.push(d);
    days.push(to);
    return days.join(',');
  }
  // «los lunes», «cada martes», «los lunes y miércoles», «los lunes, martes y jueves».
  const list = new RegExp(
    `\\b(?:los|cada) (${DAY})((?:\\s*,\\s*(?:los )?(?:${DAY}))*(?:\\s+y\\s+(?:los )?(?:${DAY}))?)\\b`,
  ).exec(normalised);
  if (!list) return null;
  const said = `${list[1]} ${list[2] ?? ''}`.match(new RegExp(`\\b(?:${DAY})\\b`, 'g')) ?? [];
  const days = [...new Set(said.map((d) => DAY_VALUE[d] as number))].sort((a, b) => a - b);
  return days.join(',');
}

/** «cada dos horas», «cada quince minutos»: numbers said in words in an interval. */
const INTERVAL_WORD_VALUE: Record<string, number> = {
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  ocho: 8,
  diez: 10,
  doce: 12,
  quince: 15,
  veinte: 20,
  treinta: 30,
};
const INTERVAL_WORDS = Object.keys(INTERVAL_WORD_VALUE).join('|');
