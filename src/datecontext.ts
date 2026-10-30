/**
 * Fecha y hora locales para el contexto del modelo.
 *
 * Antes se inyectaba `<now>` con `toISOString()`, que es UTC y sin día de la
 * semana. A las 00:33 de Madrid (22:33 UTC del día anterior) el modelo veía el
 * día anterior y resolvía "mañana" como el día actual. Aquí todo se calcula en
 * la zona horaria del usuario y "hoy" y "mañana" se dan ya resueltos.
 */
/**
 * Día local `YYYY-MM-DD` (el día que ve el usuario), no el día UTC.
 *
 * `toISOString().slice(0, 10)` da la fecha UTC: entre las 00:00 y la 01:00 (02:00 en
 * verano) de Madrid devuelve el día anterior. Lee la zona del proceso, que
 * `applyConfiguredTimeZone` alinea con PA_TIMEZONE al arrancar. Úsalo para todo «hoy».
 */
export function localDay(date: Date | number = new Date()): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function localTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PA_TIMEZONE?.trim();
  if (configured) {
    try {
      new Intl.DateTimeFormat('es-ES', { timeZone: configured });
      return configured;
    } catch {
      // Zona inválida: se cae a la del sistema en lugar de romper el arranque.
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * Makes the process clock agree with the zone the model is told about.
 *
 * `<now>` is built in `localTimeZone()` (PA_TIMEZONE), but croner, `new Date(y, m, d, h)`
 * and the reminder tool all read the process zone. On a server in UTC with
 * PA_TIMEZONE=Europe/Madrid a reminder for "11:42" fired at 11:42 UTC, two hours late.
 * Setting TZ once at start-up (Node re-reads it at runtime) keeps every consumer on the
 * same zone. Returns the zone applied, or null when PA_TIMEZONE is unset or invalid.
 */
export function applyConfiguredTimeZone(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.PA_TIMEZONE?.trim();
  if (!configured) return null;
  try {
    new Intl.DateTimeFormat('es-ES', { timeZone: configured });
  } catch {
    return null;
  }
  env.TZ = configured;
  return configured;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localParts(at: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const get = (type: string): number =>
    Number(fmt.formatToParts(at).find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  };
}

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function describeDay(year: number, month: number, day: number): string {
  // Mediodía UTC: el día de la semana de una fecha de calendario no depende de la zona.
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay()];
  return `${weekday} ${pad(day)}/${pad(month)}/${year} (${year}-${pad(month)}-${pad(day)})`;
}

export function buildNowNote(at: Date = new Date(), timeZone: string = localTimeZone()): string {
  const p = localParts(at, timeZone);
  const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1, 12));
  return [
    '<now>',
    `Zona horaria: ${timeZone}`,
    `Ahora: ${pad(p.hour)}:${pad(p.minute)}, ${describeDay(p.year, p.month, p.day)}`,
    `Hoy: ${describeDay(p.year, p.month, p.day)}`,
    `Mañana: ${describeDay(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate())}`,
    '"Mañana" es siempre el día siguiente a "Hoy", también de madrugada.',
    '</now>',
  ].join('\n');
}
