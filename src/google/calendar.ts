/**
 * Tu Google Calendar en la agenda: lee los eventos con la API oficial (solo lectura)
 * y los entrega como texto iCal, el mismo formato que el calendario local y la
 * dirección secreta iCal, así la agenda, el resumen diario y la herramienta
 * `calendar` los leen sin cambios. Sin conexión con Google, no hace nada.
 */
import { GoogleAuth, type GoogleDeps, googleFetch } from './oauth.js';

export const GOOGLE_CALENDAR_EVENTS_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/** Días hacia delante que se piden (la agenda nunca mira más de 60). */
const AHEAD_DAYS = 62;
const MAX_EVENTS = 250;
const DAY_MS = 86_400_000;

interface GoogleTime {
  date?: unknown;
  dateTime?: unknown;
}

interface GoogleEvent {
  id?: unknown;
  status?: unknown;
  summary?: unknown;
  location?: unknown;
  description?: unknown;
  transparency?: unknown;
  start?: GoogleTime;
  end?: GoogleTime;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Escapa un valor de texto iCal (RFC 5545 §3.3.11). */
function icsText(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

const pad = (n: number) => String(n).padStart(2, '0');

function icsUtc(iso: string): string | undefined {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return undefined;
  const d = new Date(t);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function icsDate(day: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.replaceAll('-', '') : undefined;
}

function icsTime(prop: 'DTSTART' | 'DTEND', t: GoogleTime | undefined): string | undefined {
  const day = icsDate(text(t?.date));
  if (day) return `${prop};VALUE=DATE:${day}`;
  const at = icsUtc(text(t?.dateTime));
  return at ? `${prop}:${at}` : undefined;
}

/** Eventos de la API de Google → un VCALENDAR que parseIcs entiende. */
export function googleEventsToIcs(items: unknown[]): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Asistenta//Google Calendar//ES'];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as GoogleEvent;
    if (e.status === 'cancelled') continue;
    const start = icsTime('DTSTART', e.start);
    if (!start) continue;
    const end = icsTime('DTEND', e.end);
    lines.push('BEGIN:VEVENT', `UID:${icsText(text(e.id) || 'google')}@google`, start);
    if (end) lines.push(end);
    lines.push(`SUMMARY:${icsText(text(e.summary) || '(sin título)')}`);
    if (text(e.location)) lines.push(`LOCATION:${icsText(text(e.location))}`);
    if (text(e.description)) lines.push(`DESCRIPTION:${icsText(text(e.description))}`);
    if (e.transparency === 'transparent') lines.push('TRANSP:TRANSPARENT');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}

export interface GoogleCalendarDeps extends GoogleDeps {
  /** Para pruebas; por defecto el reloj real. */
  clock?: () => number;
}

/**
 * Los próximos eventos de tu calendario principal de Google como texto iCal, o
 * undefined si Google no está conectado o no dio permiso de calendario. Un fallo
 * de red o de permiso se lanza con un mensaje en castellano, sin el token.
 */
export async function readGoogleCalendar(deps: GoogleCalendarDeps): Promise<string | undefined> {
  const auth = new GoogleAuth(deps);
  if (!(await auth.connected())) return undefined;
  const scopes = await auth.scopes();
  if (!scopes.some((s) => s.includes('/auth/calendar'))) return undefined;
  const token = await auth.accessToken();
  const now = (deps.clock ?? Date.now)();
  const url = new URL(GOOGLE_CALENDAR_EVENTS_URL);
  url.searchParams.set('timeMin', new Date(now - DAY_MS).toISOString());
  url.searchParams.set('timeMax', new Date(now + AHEAD_DAYS * DAY_MS).toISOString());
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', String(MAX_EVENTS));
  let res: Response;
  try {
    res = await googleFetch(deps, url.toString(), {
      headers: { authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('No he podido leer tu Google Calendar: no hay conexión o Google no responde.');
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      'Google no me deja leer tu calendario. Vuelve a conectarlo con «pa google conectar» en el PC.',
    );
  }
  if (!res.ok) {
    throw new Error(
      `No he podido leer tu Google Calendar ahora mismo (Google respondió ${res.status}).`,
    );
  }
  const json = (await res.json().catch(() => ({}))) as { items?: unknown };
  return googleEventsToIcs(Array.isArray(json.items) ? json.items : []);
}

/** Lector para la agenda con el vault real (carga perezosa). */
export function googleCalendarReader(): () => Promise<string | undefined> {
  return async () => {
    const { vaultDelete, vaultGet, vaultSet } = await import('../vault.js');
    return readGoogleCalendar({ vault: { get: vaultGet, set: vaultSet, delete: vaultDelete } });
  };
}
