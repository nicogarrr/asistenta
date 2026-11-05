/**
 * Las horas en que el dueño ha dicho que no le escriban («no me escribas antes de las 9»,
 * «no me mandes nada después de las 11»), leídas de lo que él mismo contó y quedó en su
 * perfil (owner-facts). Los avisos que Asistenta manda por su cuenta (vigilante, «¿qué tal
 * fue?») respetan estas horas en vez de solo las de serie (22–8).
 */
import { DEFAULT_QUIET_HOURS, type QuietHours } from '../ojo.js';
import { foldAccents } from '../text.js';
import { SAID_PREFIX } from './owner-facts.js';

/**
 * «no me escribas», también dicho de otras formas: «nunca me escribas», «no quiero que me
 * escribas», «no me notifiques (nada)», «no me mandes notificaciones / avisos». Antes esas
 * se apuntaban (o se ignoraban) y las horas de silencio seguían las de serie.
 */
const DONT =
  '(?:no|nunca) (?:quiero que )?me (?:escribas|notifiques(?: nada)?|(?:mandes|envies)(?: nada| mensajes| notificaciones| avisos)?|hables|avises|despiertes|molestes)';
/** «las 9», «las nueve», «las 9:30», «las 9 y media». «La una» no: es la hora de comer. */
const HOUR = String.raw`(?:la|las) (\d{1,2}|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)(?:(?::|\.)(\d{2})| y (media|cuarto))?`;
const PART = '(?: de la (manana|tarde|noche|madrugada))?';
/**
 * Las dos horas en la misma frase: «no me escribas antes de las 9 ni después de las 11»,
 * «ni antes de las 9 ni después de las 23», «después de las 11 y antes de las 9». Antes
 * solo se leía la hora pegada a «no me escribas» y la otra se perdía en silencio.
 */
const JOIN = String.raw`(?:[^.;!?]*?(?:,|\by|\bni|\bo)\s)?`;
const BEFORE = new RegExp(`${DONT}(?: ni)? ${JOIN}(?:antes de|hasta) ${HOUR}${PART}`);
const AFTER = new RegExp(
  `${DONT}(?: ni)? ${JOIN}(?:despues de|a partir de|mas tarde de|desde) ${HOUR}${PART}`,
);
/**
 * «no me escribas entre las 23 y las 8», «de 11 de la noche a 8 de la mañana», «desde las 23
 * hasta las 9», «de 10 a 7»: las dos horas como franja. Antes se apuntaba el dato
 * («📝 Apuntado») pero las horas de silencio no lo leían y seguían las de serie.
 */
const RANGE_HOUR = String.raw`(?:(?:la|las) )?(\d{1,2}|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)(?:(?::|\.)(\d{2})| y (media|cuarto))?`;
const RANGE = new RegExp(
  `${DONT} (?:entre|de|desde) ${RANGE_HOUR}${PART} (?:y|a|hasta) ${RANGE_HOUR}${PART}(?![:.]?\\d)`,
);
const WORD_HOUR: Record<string, number> = {
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

/** Silencio de más horas que esto no es una preferencia de horario: se ignora. */
export const MAX_QUIET_SPAN_HOURS = 16;

function hour24(raw: string, part: string | undefined, kind: 'before' | 'after'): number | null {
  let h = /^\d+$/.test(raw) ? Number(raw) : (WORD_HOUR[raw] ?? Number.NaN);
  if (!Number.isInteger(h) || h < 0 || h > 24) return null;
  if (h === 24) h = 0;
  // «las 12 de la noche» es la medianoche, y «después de las 12» habla de la noche: antes
  // quedaban a mediodía, el silencio salía de más de 16 h y se descartaba entero.
  if (h === 12 && (part === 'noche' || (part === undefined && kind === 'after'))) return 0;
  // «de la madrugada» no suma 12: «después de la 1 de la madrugada» es la 01:00.
  if (part === 'madrugada') return h === 12 ? 0 : h;
  if (part === 'tarde' || part === 'noche') {
    if (h >= 1 && h <= 11) h += 12;
  } else if (part !== 'manana' && kind === 'after' && h >= 1 && h <= 11) {
    // «después de las 10» habla de la noche.
    h += 12;
  }
  return h;
}

/**
 * Las horas de una franja. Con la parte del día dicha, como siempre. Sin ella: si la franja
 * da la vuelta a la medianoche («de 10 a 7») el principio es de la noche (22); si no («entre
 * la 1 y las 7», «de 9 a 11») se toma tal cual.
 */
function rangeHours(m: RegExpExecArray): QuietHours | null {
  const [, sRaw = '', , , sPart, eRaw = '', eMin, eHalf, ePart] = m;
  const literal = (raw: string): number =>
    /^\d+$/.test(raw) ? Number(raw) : (WORD_HOUR[raw] ?? Number.NaN);
  let start = sPart ? hour24(sRaw, sPart, 'after') : literal(sRaw);
  let end = ePart ? hour24(eRaw, ePart, 'before') : literal(eRaw);
  if (start === null || end === null || !Number.isInteger(start) || !Number.isInteger(end))
    return null;
  if (start < 0 || start > 24 || end < 0 || end > 24) return null;
  start %= 24;
  end %= 24;
  if (!sPart && !ePart && start >= 1 && start <= 11 && end < start) start += 12;
  // «hasta las 8 y media»: hasta la hora siguiente, mejor de más que de menos.
  const extra = (eMin && eMin !== '00') || eHalf ? 1 : 0;
  return { startHour: start, endHour: (end + extra) % 24 };
}

function span({ startHour, endHour }: QuietHours): number {
  return (endHour - startHour + 24) % 24;
}

/**
 * Horas de silencio que el dueño dijo él mismo, o null si no ha dicho ninguna (o lo
 * dicho deja un silencio de más de MAX_QUIET_SPAN_HOURS). Si lo ha dicho varias veces
 * gana lo último apuntado.
 */
export function ownerStatedQuiet(
  entries: readonly string[],
  base: QuietHours = DEFAULT_QUIET_HOURS,
): QuietHours | null {
  let { startHour, endHour } = base;
  let stated = false;
  for (const entry of entries) {
    const e = entry.trim();
    if (!e.startsWith(SAID_PREFIX)) continue;
    // «después de medianoche», «entre la medianoche y las 7»: son las 12 de la noche. Antes no
    // se leían y seguían las horas de serie aunque se contestara «📝 Apuntado».
    const t = foldAccents(e.slice(SAID_PREFIX.length).toLowerCase()).replace(
      /\b(?:la |las )?medianoche\b/g,
      'las 12 de la noche',
    );
    const range = RANGE.exec(t);
    const hours = range ? rangeHours(range) : null;
    if (hours) {
      ({ startHour, endHour } = hours);
      stated = true;
      continue;
    }
    const before = BEFORE.exec(t);
    if (before) {
      const h = hour24(before[1] ?? '', before[4], 'before');
      // «antes de las 9 y media»: hasta la hora siguiente, mejor de más que de menos.
      const extra = (before[2] && before[2] !== '00') || before[3] ? 1 : 0;
      if (h !== null) {
        endHour = (h + extra) % 24;
        stated = true;
      }
    }
    const after = AFTER.exec(t);
    if (after) {
      const h = hour24(after[1] ?? '', after[4], 'after');
      if (h !== null) {
        startHour = h;
        stated = true;
      }
    }
  }
  const out = { startHour, endHour };
  return stated && span(out) <= MAX_QUIET_SPAN_HOURS ? out : null;
}

/**
 * Horas de silencio del dueño: las de serie, con el principio o el final que él haya
 * dicho. Si lo ha dicho varias veces gana lo último apuntado.
 */
export function ownerQuietHours(
  entries: readonly string[],
  base: QuietHours = DEFAULT_QUIET_HOURS,
): QuietHours {
  return ownerStatedQuiet(entries, base) ?? base;
}
