/**
 * El resumen de la mañana se activaba solo con PA_BRIEFING=1. Quien escribía
 * «PA_BRIEFING=sí» o «true» en el .env no recibía nada y no sabía por qué; y
 * PA_BRIEFING_HOUR=24 o 25 lo dejaba sin salir nunca. Aquí se leen como lo
 * escribiría una persona.
 */

const SI = new Set(['1', 'si', 'true', 'yes', 'on', 'activado', 'activo']);

/** ¿Encendido? Acepta 1, sí/si, true, yes, on (sin importar mayúsculas). */
export function envOn(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  return SI.has(v);
}

/** Hora del resumen (0–23). «8», «08», «8:30» → 8. Lo que no es una hora → por defecto. */
export function briefingHour(value: string | undefined): number | undefined {
  const m = /^\s*(\d{1,2})(?:[:.h]\d{0,2})?\s*$/i.exec(value ?? '');
  if (!m) return undefined;
  const h = Number(m[1]);
  return h >= 0 && h <= 23 ? h : undefined;
}
