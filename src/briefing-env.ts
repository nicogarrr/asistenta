/**
 * El resumen de la mañana se activaba solo con PA_BRIEFING=1. Quien escribía
 * «PA_BRIEFING=sí» o «true» en el .env no recibía nada y no sabía por qué; y
 * PA_BRIEFING_HOUR=24 o 25 lo dejaba sin salir nunca. Aquí se leen como lo
 * escribiría una persona.
 */

import { DEFAULT_BRIEFING_HOUR, weatherConfigFromEnv } from './briefing-daily.js';

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

const NO = new Set(['', '0', 'no', 'false', 'off', 'apagado']);
const shown = (v: string) => v.replace(/[^\p{L}\p{N} :.,_-]/gu, '').slice(0, 30);

/**
 * Línea de `pa doctor` para el resumen de la mañana: si está encendido, a qué hora
 * y con el tiempo de dónde; si un valor del .env no se entiende, lo dice.
 */
export function briefingDoctorLine(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.PA_BRIEFING ?? '').trim();
  if (!envOn(raw)) {
    const normal = NO.has(raw.toLowerCase());
    return normal
      ? 'resumen         apagado (pon PA_BRIEFING=1 en el archivo .env para recibirlo cada mañana)'
      : `resumen         PA_BRIEFING «${shown(raw)}» no se entiende: pon 1 para activarlo o 0 para apagarlo`;
  }
  const rawHour = (env.PA_BRIEFING_HOUR ?? '').trim();
  const hour = briefingHour(rawHour);
  const parts = [`resumen         cada mañana a las ${hour ?? DEFAULT_BRIEFING_HOUR}:00`];
  if (rawHour && hour === undefined) {
    parts.push(`(PA_BRIEFING_HOUR «${shown(rawHour)}» no vale: pon una hora de 0 a 23)`);
  }
  const weather = weatherConfigFromEnv(env);
  if (weather) parts.push(`con el tiempo${weather.label ? ` de ${shown(weather.label)}` : ''}`);
  else if (env.PA_BRIEFING_LAT?.trim() || env.PA_BRIEFING_LON?.trim()) {
    parts.push(
      'sin el tiempo: PA_BRIEFING_LAT o PA_BRIEFING_LON no valen (p. ej. 40.4168 y -3.7038)',
    );
  } else parts.push('sin el tiempo (pon PA_BRIEFING_LAT y PA_BRIEFING_LON para verlo)');
  return parts.join(', ').replace(', (', ' (');
}
