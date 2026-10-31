/**
 * Las horas en que el dueño ha dicho que no le escriban («no me escribas antes de las 9»,
 * «no me mandes nada después de las 11»), leídas de lo que él mismo contó y quedó en su
 * perfil (owner-facts). Los avisos que Asistenta manda por su cuenta (vigilante, «¿qué tal
 * fue?») respetan estas horas en vez de solo las de serie (22–8).
 */
import { DEFAULT_QUIET_HOURS, type QuietHours } from '../ojo.js';
import { foldAccents } from '../text.js';
import { SAID_PREFIX } from './owner-facts.js';

const DONT = 'no me (?:escribas|mandes(?: nada| mensajes)?|hables|avises|despiertes|molestes)';
const HOUR = String.raw`(?:la|las) (\d{1,2})(?:(?::|\.)(\d{2})| y (?:media|cuarto))?`;
const BEFORE = new RegExp(`${DONT} antes de ${HOUR}(?: de la (manana|tarde|noche))?`);
const AFTER = new RegExp(
  `${DONT} (?:despues de|a partir de|mas tarde de) ${HOUR}(?: de la (manana|tarde|noche))?`,
);

/** Silencio de más horas que esto no es una preferencia de horario: se ignora. */
export const MAX_QUIET_SPAN_HOURS = 16;

function hour24(raw: string, part: string | undefined, kind: 'before' | 'after'): number | null {
  let h = Number(raw);
  if (!Number.isInteger(h) || h < 0 || h > 24) return null;
  if (h === 24) h = 0;
  if (part === 'tarde' || part === 'noche') {
    if (h >= 1 && h <= 11) h += 12;
  } else if (part !== 'manana' && kind === 'after' && h >= 1 && h <= 11) {
    // «después de las 10» habla de la noche.
    h += 12;
  }
  return h;
}

function span({ startHour, endHour }: QuietHours): number {
  return (endHour - startHour + 24) % 24;
}

/**
 * Horas de silencio del dueño: las de serie, con el principio o el final que él haya
 * dicho. Si lo ha dicho varias veces gana lo último apuntado.
 */
export function ownerQuietHours(
  entries: readonly string[],
  base: QuietHours = DEFAULT_QUIET_HOURS,
): QuietHours {
  let { startHour, endHour } = base;
  for (const entry of entries) {
    const e = entry.trim();
    if (!e.startsWith(SAID_PREFIX)) continue;
    const t = foldAccents(e.slice(SAID_PREFIX.length).toLowerCase());
    const before = BEFORE.exec(t);
    if (before) {
      const h = hour24(before[1] ?? '', before[3], 'before');
      // «antes de las 9 y media»: hasta la hora siguiente, mejor de más que de menos.
      const extra =
        before[2] && before[2] !== '00' ? 1 : /y (?:media|cuarto)/.test(before[0]) ? 1 : 0;
      if (h !== null) endHour = (h + extra) % 24;
    }
    const after = AFTER.exec(t);
    if (after) {
      const h = hour24(after[1] ?? '', after[3], 'after');
      if (h !== null) startHour = h;
    }
  }
  const out = { startHour, endHour };
  return span(out) > MAX_QUIET_SPAN_HOURS ? base : out;
}
