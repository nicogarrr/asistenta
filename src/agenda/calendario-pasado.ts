import { wallClock } from '../datecontext.js';

/** «sí», «vale», «apúntalo»…: la respuesta que confirma apuntar algo que ya pasó. */
const SI =
  /^(?:s[ií]|vale|venga|ok|okay|claro|dale|hazlo|ap[uú]ntalo|ap[uú]ntala|igualmente)[.!]*$/i;

export function esSiCalendario(text: string): boolean {
  return SI.test(text.trim());
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * /calendario con una fecha que ya ha pasado («el 2 de noviembre a las 10» dicho el 2 a
 * las 11): antes se apuntaba sin decir nada y el evento quedaba atrás. Ahora se pregunta.
 * Devuelve la pregunta, o null si la fecha aún no ha llegado (con un minuto de margen).
 */
export function preguntaFechaPasada(start: Date, now: Date, timeZone?: string): string | null {
  if (start.getTime() >= now.getTime() - 60_000) return null;
  const w = wallClock(start, timeZone);
  const today = wallClock(now, timeZone);
  const sameDay = w.year === today.year && w.month === today.month && w.day === today.day;
  const day = sameDay
    ? 'hoy'
    : `el ${pad(w.day)}/${pad(w.month)}${w.year === today.year ? '' : `/${w.year}`}`;
  return `Eso ya ha pasado (${day} a las ${pad(w.hour)}:${pad(w.minute)}). ¿Lo apunto igualmente? Dime «sí», o dime otra fecha.`;
}

/**
 * Respuesta al apuntar con /calendario: «el 05/11 a las 10:30» en la zona del asistente.
 * Antes era start.toLocaleString('es-ES'): con segundos y en la zona del ordenador.
 */
export function confirmacionCalendario(
  title: string,
  start: Date,
  now: Date,
  timeZone?: string,
): string {
  const w = wallClock(start, timeZone);
  const today = wallClock(now, timeZone);
  // El día siguiente del calendario, no «ahora + 24 h» (los días del cambio de hora no tienen 24 h).
  const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  const tomorrow = {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
  const isDay = (d: { year: number; month: number; day: number }): boolean =>
    d.year === w.year && d.month === w.month && d.day === w.day;
  const day = isDay(today)
    ? 'hoy'
    : isDay(tomorrow)
      ? 'mañana'
      : `el ${pad(w.day)}/${pad(w.month)}${w.year === today.year ? '' : `/${w.year}`}`;
  return `Añadido al calendario local (no a Google): ${title} — ${day} a las ${pad(w.hour)}:${pad(w.minute)}.`;
}
