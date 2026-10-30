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
  // El día se calcula en la MISMA zona que `localTimeZone()` (PA_TIMEZONE si es válida),
  // no en la del proceso: los subcomandos `pa …` y los tests no pasan por
  // `applyConfiguredTimeZone`, y con TZ=UTC y PA_TIMEZONE=Europe/Madrid «hoy» a las
  // 00:30 era ayer mientras `<now>` ya decía hoy.
  const zone = localTimeZone();
  let fmt = dayFormatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(zone, fmt);
  }
  const parts = fmt.formatToParts(d);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

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

const WALL_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Instante (ms) de una fecha y hora de pared en la zona configurada (PA_TIMEZONE).
 * Inversa de `wallClock`; lo que `new Date(y, m, d, h)` hace en la zona del proceso.
 */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  timeZone: string = localTimeZone(),
): number {
  // Date.UTC normaliza desbordes (día 32 → día 1 del mes siguiente); dos pasadas
  // asientan el desfase de la zona, cambios de hora incluidos.
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let at = naive;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(new Date(at), timeZone);
    at -= Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - naive;
  }
  return at;
}

/**
 * Fecha y hora de pared de `d` en la zona configurada (PA_TIMEZONE), no en la del
 * proceso. Para todo lo que se enseña o se programa por hora local fuera de
 * `applyConfiguredTimeZone` (tests, e2e, librería). weekday: 0 = domingo.
 */
export function wallClock(
  d: Date,
  timeZone: string = localTimeZone(),
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: WALL_WEEKDAYS.indexOf(get('weekday')),
  };
}
