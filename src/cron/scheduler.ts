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
function parseNaturalCore(text: string): { schedule: string; prompt: string } | null {
  const normalised = foldAccents(text)
    .replace(/\s+/g, ' ')
    .trim()
    // «a las 8 pm», «8:30 p.m.», «12 am»: antes se ignoraba y «8 pm» sonaba a las 8:00.
    .replace(/\b(\d{1,2})(?:[:.](\d{2}))?\s?([ap])\.?\s?m\b\.?/g, (_m, h, min, ap) => {
      let hour = Number(h);
      if (ap === 'p' && hour >= 1 && hour < 12) hour += 12;
      if (ap === 'a' && hour === 12) hour = 0;
      return min ? `${hour}:${min}` : `${hour}`;
    });

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
    // «los lunes a las 9 y los jueves a las 5»: otro día con su propia hora. Un cron no
    // dice dos horarios distintos; antes el segundo se perdía sin avisar.
    if (
      new RegExp(
        `\\by\\s+(?:el\\s+|los\\s+|cada\\s+)?(?:${DAY})\\b.*?\\ba\\s+las?\\s+${CLOCK}`,
      ).test(rest)
    ) {
      return null;
    }
    const part = timeMatch[6];
    // Solo la tarde o la noche como parte del día («por la tarde», «esta noche», «las
    // tardes»): «no llegar tarde» o «el resumen de anoche» no mueven la hora doce horas.
    const dayPart = /\b(?:la|las|esta|cada|de|por) (?:tarde|noche)s?\b/.test(normalised);
    if (!part && extraHours.length === 0 && dayPart && hour < 12) {
      // "a las 6 … por la tarde" means six in the evening to a person, and a scheduler
      // that fires at 6 a.m. instead is the kind of bug that makes people stop using it.
      // Without a part of day next to the clock, the modifier counts anywhere.
      hour += 12;
    }
  } else if (/\b(?:a )?medianoche\b/.test(normalised)) {
    hour = 0;
    hasTime = true;
    // «al mediodía y a medianoche»: las dos (antes se perdía el mediodía).
    if (/\bmediodia\b/.test(normalised)) extraHours.push(12);
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
  // «tres veces al día a las 8», «cada día dos veces»: con menos horas que veces, antes
  // sonaba una sola vez. Se pregunta.
  const times =
    /\b(dos|tres|cuatro|cinco|seis|\d{1,2}) veces (?:al|cada|por) dia\b|\bcada dia (dos|tres|cuatro|cinco|seis|\d{1,2}) veces\b/.exec(
      normalised,
    );
  if (times) {
    const said = times[1] ?? times[2] ?? '';
    const n = /^\d+$/.test(said) ? Number(said) : TIMES_WORD_VALUE[said];
    if (!hasTime || hours.split(',').length !== n) return null;
  }

  // «cada 2 días», «cada dos semanas», «el último día de cada mes»: a cron cannot say
  // them simply. Before, they became «every day»; now the caller asks.
  if (/\bcada (?:\d{1,3}|[a-z]+) (?:dias|semanas|meses)\b/.test(normalised)) return null;
  // «durante una semana», «hasta el viernes», «hasta fin de mes»: un cron no tiene fin y la
  // rutina sonaba para siempre. Se pregunta («hasta las 20» o «hasta el 25 de diciembre»
  // dentro de la tarea no son un fin).
  if (
    new RegExp(
      `\\bdurante (?:una?|unos|unas|\\d+|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta|varios|varias) (?:dias?|semanas?|mes(?:es)?|anos?)\\b|\\bhasta (?:el (?:${DAY})|(?:el )?(?:fin|final|finales) de (?:la |el )?(?:mes|semana|ano)|manana|pasado manana)\\b`,
    ).test(normalised)
  )
    return null;
  if (/\bultimo dia\b/.test(normalised) && /\bmes(?:es)?\b/.test(normalised)) return null;
  // «excepto festivos», «salvo los festivos», «los festivos a las 10»: un cron no sabe qué
  // días son festivos y antes se ignoraba (sonaba también en Navidad). Se pregunta.
  if (
    /\b(?:excepto|menos|salvo|quitando|sin contar|que no sean?|no) (?:en )?(?:el |los )?(?:dias? )?festivos?\b/.test(
      normalised,
    ) ||
    /^(?:los |todos los |cada )(?:dias )?festivos?\b|\b(?:los|todos los|cada) (?:dias )?festivos? a las?\b/.test(
      normalised,
    )
  )
    return null;
  // «cada segundo martes», «el primer lunes de mes», «el último viernes»: tampoco cabe en
  // un cron. Antes «cada segundo martes» sonaba todos los días.
  if (
    new RegExp(`\\b(?:primer|primero|segundo|tercer|tercero|cuarto|ultimo)s? (?:${DAY})\\b`).test(
      normalised,
    )
  )
    return null;

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
  // «los días 1 y 15 de cada mes», «el 1 y el 15 de cada mes», «cada mes los días 5, 15 y
  // 25»: antes solo quedaba el último día (el 15).
  const severalDays =
    /\bmes\b/.test(normalised) &&
    /(?:\blos dias|\bel|\bcada) (\d{1,2}((?:\s*,\s*(?:el )?\d{1,2})*\s+y\s+(?:el )?\d{1,2}))\b(?! ?(?:h\b|horas?|minutos?|min\b|veces))/.exec(
      normalised,
    );
  if (severalDays) {
    const days = [...new Set((severalDays[1] ?? '').match(/\d{1,2}/g)?.map(Number) ?? [])];
    if (days.some((d) => d < 1 || d > 31)) return null;
    days.sort((a, b) => a - b);
    return {
      schedule: `${minute} ${hasTime ? hours : 8} ${days.join(',')} * *`,
      prompt: text.trim(),
    };
  }
  // «cada día 5 a las 9»: el día 5 de cada mes, no todos los días.
  const dayEachMonth = /\bcada dia (\d{1,2})\b(?! (?:veces|minutos?|min|horas?))/.exec(normalised);
  if (dayEachMonth) {
    const day = Number(dayEachMonth[1]);
    if (day < 1 || day > 31) return null;
    return { schedule: `${minute} ${hasTime ? hours : 8} ${day} * *`, prompt: text.trim() };
  }

  // «cada 1 de mes a las 9», «cada 15 del mes», «cada primero de mes»: antes sonaban
  // todos los días.
  const dayOfMonth = /\b(?:cada|todos los) (\d{1,2}|primero) del? mes\b/.exec(normalised);
  if (dayOfMonth) {
    const day = dayOfMonth[1] === 'primero' ? 1 : Number(dayOfMonth[1]);
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
  // La franja («de 9 a 18», «entre las 9 y las 14») y los días («de lunes a viernes», «los
  // lunes») cuentan también: antes «cada hora de 9 a 18» sonaba toda la noche y «cada
  // media hora de lunes a viernes», también el finde.
  // «cada hora por la mañana», «cada media hora en horario laboral»: antes sonaban todo el
  // día (y el finde). Una franja dicha con horas («de 9 a 12») manda.
  const workday = WORKDAY.test(normalised);
  const part = /\b(?:por|durante) las? (manana|tarde|noche)s?\b/.exec(normalised)?.[1];
  const said = hourWindow(normalised);
  const window =
    said !== undefined ? said : workday ? { from: 9, to: 18 } : PART_OF_DAY_WINDOW[part ?? ''];
  const dowField = daysOfWeek(normalised) ?? (workday ? '1-5' : '*');
  const every = (minutes: number): { schedule: string; prompt: string } | null => {
    if (window === null) return null;
    if (minutes < 60) {
      const hoursField = window ? `${window.from}-${window.to - 1}` : '*';
      return { schedule: `*/${minutes} ${hoursField} * * ${dowField}`, prompt: text.trim() };
    }
    const step = minutes / 60;
    if (step === 24)
      return window ? null : { schedule: `0 0 * * ${dowField}`, prompt: text.trim() };
    const range = window ? `${window.from}-${Math.min(window.to, 23)}` : '*';
    const hoursField = step === 1 ? range : `${range}/${step}`;
    return { schedule: `0 ${hoursField} * * ${dowField}`, prompt: text.trim() };
  };
  // «cada hora y media», «cada 2 horas y cuarto»: un cron no lo dice (antes sonaba cada
  // hora o cada 2 horas). Se pregunta, como «cada 90 minutos».
  if (
    /\bcada (?:\S+ )?horas? y (?:media|cuarto|tres cuartos|\d{1,2} min(?:utos)?)\b/.test(normalised)
  )
    return null;
  if (/\bcada media hora\b/.test(normalised)) return every(30);
  if (/\bcada cuarto de hora\b/.test(normalised)) return every(15);
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
    if (unit.startsWith('min') && 60 % n === 0) return every(n);
    if (!Number.isInteger(hours) || 24 % hours !== 0) return null;
    return every(hours * 60);
  }
  if (/cada hora\b/.test(normalised)) return every(60);
  // «todos los días excepto los domingos», «de lunes a viernes menos el miércoles»:
  // antes los días quitados se leían como los días de la rutina (solo los domingos).
  const except = exceptDays(normalised);
  if (except) {
    const base = daysOfWeek(normalised.slice(0, except.index));
    const left = (base === null ? [0, 1, 2, 3, 4, 5, 6] : expandDays(base)).filter(
      (d) => !except.days.includes(d),
    );
    if (left.length === 0) return null;
    return {
      schedule: `${minute} ${hasTime ? hours : 8} * * ${left.join(',')}`,
      prompt: text.trim(),
    };
  }
  if (
    /cada dia|todos los dias|diariamente/.test(normalised) &&
    !hasTime &&
    !LABORABLES.test(normalised)
  ) {
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

/**
 * Turn an ordinary Spanish sentence into a schedule; see parseNaturalCore.
 *
 * «cada lunes a las 9 en diciembre», «de enero a marzo», «los lunes de diciembre»: el
 * mes dicho junto al horario va al campo de meses. Antes se ignoraba y la rutina sonaba
 * todo el año. Si el mes puede ser parte de la tarea («recuérdame comprar turrón en
 * diciembre») o es una estación («en verano»), se pregunta.
 */
export function parseNatural(text: string): { schedule: string; prompt: string } | null {
  const normalised = foldAccents(text).replace(/\s+/g, ' ').trim();
  const said = monthsSaid(normalised);
  if (said === null) return null;
  if (!said) return parseNaturalCore(text);
  const parsed = parseNaturalCore(
    `${normalised.slice(0, said.start)} ${normalised.slice(said.end)}`.replace(/\s+/g, ' '),
  );
  if (!parsed) return null;
  const fields = parsed.schedule.split(' ');
  // «cada 25 de diciembre … en enero»: ya tiene mes y no casa; se pregunta.
  if (fields.length !== 5 || fields[3] !== '*') return null;
  const first = said.months[0] as number;
  fields[3] =
    said.months.length > 2 && said.months.every((m, i) => m === first + i)
      ? `${first}-${said.months.at(-1)}`
      : said.months.join(',');
  return { schedule: fields.join(' '), prompt: text.trim() };
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
/** «entre semana», «los días laborables», «cada día laborable», «los laborables». */
const LABORABLES =
  /\b(?:entre semana|(?:los |cada |todos los )?dias? (?:laborables?|habil(?:es)?|de diario)|los laborables|de lunes a viernes)\b/;

/** The cron day-of-week field for the days said, or null when no day is said. */
function daysOfWeek(normalised: string): string | null {
  if (LABORABLES.test(normalised)) return '1-5';
  if (/\b(?:los|cada|el) (?:fin(?:es)? de semana|findes?)\b/.test(normalised)) return '0,6';
  // «de lunes a viernes», «del lunes al viernes» y también «lunes a viernes» sin «de»
  // (antes sonaba todos los días).
  const range = new RegExp(`\\b(?:del? )?(${DAY}) al? (${DAY})\\b`).exec(normalised);
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
    `\\b(?:los|cada) (${DAY})((?:\\s*,\\s*(?:los |cada |el )?(?:${DAY}))*(?:\\s+y\\s+(?:los |cada |el )?(?:${DAY}))?)\\b`,
  ).exec(normalised);
  if (!list) return null;
  const said = `${list[1]} ${list[2] ?? ''}`.match(new RegExp(`\\b(?:${DAY})\\b`, 'g')) ?? [];
  const days = [...new Set(said.map((d) => DAY_VALUE[d] as number))].sort((a, b) => a - b);
  return days.join(',');
}

const TIMES_WORD_VALUE: Record<string, number> = { dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };

/** «en horario laboral», «en horario de oficina», «en horas de trabajo». */
const WORKDAY = /\ben (?:horario|horas?) (?:laboral(?:es)?|de (?:oficina|trabajo))\b/;
/** La franja de un intervalo dicho con una parte del día («cada hora por la mañana»). */
const PART_OF_DAY_WINDOW: Record<string, { from: number; to: number }> = {
  manana: { from: 8, to: 13 },
  tarde: { from: 15, to: 20 },
  noche: { from: 20, to: 23 },
};

/**
 * La franja de horas de un intervalo: «de 9 a 18», «entre las 9 y las 14», «desde las 8
 * hasta las 20», «de 4 a 8 de la tarde». undefined si no se dice; null si un cron no la
 * dice (minutos sueltos o una franja que cruza la medianoche): entonces se pregunta.
 */
function hourWindow(normalised: string): { from: number; to: number } | null | undefined {
  const m =
    /\b(?:de(?:sde)?|entre)(?: las?)? (\d{1,2})(?:[:.](\d{2}))?(?: ?h)? (?:a|hasta|y)(?: las?)? (\d{1,2})(?:[:.](\d{2}))?(?: ?h\b| horas\b)?(?! ?(?:veces|vasos|litros|personas|euros|minutos|min)\b)(?: de la (manana|tarde|noche))?/.exec(
      normalised,
    );
  if (!m) return fromOnly(normalised);
  if (Number(m[2] ?? 0) !== 0 || Number(m[4] ?? 0) !== 0) return null;
  let from = Number(m[1]);
  let to = Number(m[3]);
  if (m[5] === 'tarde' || m[5] === 'noche') {
    if (from < 12) from += 12;
    if (to < 12) to += 12;
  }
  if (to > 24 || from >= to) return null;
  return { from, to };
}

/**
 * «cada hora a partir de las 9», «cada media hora desde las 4 de la tarde»: hasta el final
 * del día. Antes la hora de inicio no se leía y sonaba también de madrugada.
 */
function fromOnly(normalised: string): { from: number; to: number } | null | undefined {
  const m =
    /\b(?:a partir de|desde) las? (\d{1,2})(?:[:.](\d{2}))?(?: ?h\b)?(?: de la (manana|tarde|noche))?/.exec(
      normalised,
    );
  if (!m) return undefined;
  if (Number(m[2] ?? 0) !== 0) return null;
  let from = Number(m[1]);
  if ((m[3] === 'tarde' || m[3] === 'noche') && from < 12) from += 12;
  return from > 23 ? null : { from, to: 24 };
}

/** Los días quitados con «excepto / menos / salvo / quitando», y dónde empieza la excepción. */
function exceptDays(normalised: string): { index: number; days: number[] } | null {
  // «menos el finde», «excepto los fines de semana», «salvo entre semana»: antes se leían
  // como los días de la rutina y sonaba justo los días quitados.
  const group =
    /\b(?:excepto|menos|salvo|quitando|sin contar) (?:el |los )?(fin(?:es)? de semana|findes?|entre semana|(?:dias )?laborables)\b/.exec(
      normalised,
    );
  if (group)
    return {
      index: group.index,
      days: /laborables|entre semana/.test(group[1] ?? '') ? [1, 2, 3, 4, 5] : [0, 6],
    };
  const m = new RegExp(
    `\\b(?:excepto|menos|salvo|quitando|sin contar) (?:el |los )?(${DAY})((?:\\s*,\\s*(?:el |los )?(?:${DAY}))*(?:\\s+(?:y|ni) (?:el |los )?(?:${DAY}))?)\\b`,
  ).exec(normalised);
  if (!m) return null;
  const said = `${m[1]} ${m[2] ?? ''}`.match(new RegExp(`\\b(?:${DAY})\\b`, 'g')) ?? [];
  return { index: m.index, days: said.map((d) => DAY_VALUE[d] as number) };
}

/** «1-5» o «1,3,5» → los días, en números. */
function expandDays(field: string): number[] {
  return field.split(',').flatMap((part) => {
    const [a, b] = part.split('-').map(Number);
    if (b === undefined) return [a as number];
    return Array.from({ length: b - (a as number) + 1 }, (_, i) => (a as number) + i);
  });
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

const MONTH = MONTH_NAMES.join('|');
const SEASON = /\b(?:en|durante|todo) (?:el |la )?(?:verano|invierno|primavera|otono)\b/;
/** Lo que deja claro que lo que sigue aún es el horario: una hora, un día, un intervalo. */
const SCHEDULE_TAIL = new RegExp(
  `(?:^|^solo|^solamente|\\d|\\bh|\\bhoras?|\\bmin(?:utos)?|\\b(?:manana|tarde|noche|madrugada|mediodia|medianoche|punto|media|cuarto)|\\b(?:${DAY})|\\bdias|\\blaborables?|\\bhabiles|\\bsemana|\\bfind(?:e|es)|\\bdiario|\\bdiariamente|\\ba las? [a-z]+)$`,
);

/**
 * El mes que restringe una rutina: { months, start, end } con el trozo a quitar;
 * undefined si no se dice; null si no está claro (estación, o mes que puede ser tarea).
 */
function monthsSaid(
  normalised: string,
): { months: number[]; start: number; end: number } | null | undefined {
  const month = (name: string | undefined): number => MONTH_NAMES.indexOf(name ?? '') + 1;
  const ofDay = new RegExp(`\\b(?:${DAY}|dias|laborables) (de (${MONTH}))\\b`).exec(normalised);
  if (ofDay?.[1]) {
    const start = ofDay.index + ofDay[0].length - ofDay[1].length;
    return { months: [month(ofDay[2])], start, end: start + ofDay[1].length };
  }
  const range = new RegExp(
    `\\b(?:(?:de|desde) (${MONTH}) (?:a|hasta) (${MONTH})|entre (${MONTH}) y (${MONTH}))\\b`,
  ).exec(normalised);
  const list = new RegExp(
    `\\b(?:(?:solo|solamente|unicamente) )?(?:en|durante|todo)(?: el mes de)? (${MONTH})(?:(?:, | y )(${MONTH}))?\\b`,
  ).exec(normalised);
  const found = range ?? list;
  if (!found) return SEASON.test(normalised) ? null : undefined;
  // «el 1 de enero a marzo …» empieza por una fecha; «a las 8 de enero a marzo», no.
  const head = normalised.slice(0, found.index);
  if (range && /\d $/.test(head) && !/\ba las? \d{1,2}(?:[:.]\d{2})? $/.test(head))
    return undefined;
  const before = normalised.slice(0, found.index).replace(/[\s,]+$/, '');
  if (!SCHEDULE_TAIL.test(before) || SEASON.test(normalised)) return null;
  let months: number[];
  if (range) {
    const from = month(range[1] ?? range[3]);
    const to = month(range[2] ?? range[4]);
    months = [];
    for (let m = from; months.length < 12; m = (m % 12) + 1) {
      months.push(m);
      if (m === to) break;
    }
  } else months = [...new Set([month(found[1]), ...(found[2] ? [month(found[2])] : [])])];
  return { months, start: found.index, end: found.index + found[0].length };
}
