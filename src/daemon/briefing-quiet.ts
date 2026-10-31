/**
 * El resumen de la mañana respeta las horas que el dueño dijo («no me escribas antes
 * de las 10»): si su hora cae dentro, sale al terminar ese silencio. Solo cuenta lo
 * que él dijo; sin nada dicho, la hora del resumen (PA_BRIEFING_HOUR) no se toca.
 */
import { DEFAULT_BRIEFING_HOUR } from '../briefing-daily.js';
import { ownerStatedQuiet } from '../memory/owner-quiet.js';

/** ¿Cae `hour` dentro del silencio [start, end), que puede cruzar la medianoche? */
function insideQuiet(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Hora a la que sale el resumen, movida al final del silencio que dijo el dueño. */
export function briefingHourFor(hour: number | undefined, entries: readonly string[]): number {
  const base = hour ?? DEFAULT_BRIEFING_HOUR;
  const quiet = ownerStatedQuiet(entries);
  if (!quiet || !insideQuiet(base, quiet.startHour, quiet.endHour)) return base;
  return quiet.endHour;
}
