/**
 * Google Calendar (escribir), Contactos y Drive con la misma conexión OAuth del dueño
 * (oauth.ts). Cada función comprueba primero el permiso concedido y, si falta, dice el
 * paso exacto («/google conectar») en vez de fallar con un 403. Todo vuelve como texto en
 * castellano para el chat; los tokens nunca salen de aquí.
 */
import { localDay, localTimeZone } from '../datecontext.js';
import {
  faltaPermiso,
  GoogleAuth,
  type GoogleDeps,
  GoogleNotConnectedError,
  type GooglePermiso,
  googleFetch,
  NOT_CONNECTED,
  tienePermiso,
} from './oauth.js';

const CAL_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const PEOPLE_API = 'https://people.googleapis.com/v1';
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const MAX_TEXT = 12_000;

export interface WorkspaceDeps extends GoogleDeps {
  timeZone?: () => string;
}

class Aviso extends Error {}

async function token(deps: WorkspaceDeps, p: GooglePermiso): Promise<string> {
  const auth = new GoogleAuth(deps);
  if (!(await auth.connected()))
    throw new Aviso(
      NOT_CONNECTED.replace('«pa google conectar»', '«/google conectar» (o «pa google conectar»)'),
    );
  if (!tienePermiso(await auth.scopes(), p)) throw new Aviso(faltaPermiso(p));
  return auth.accessToken();
}

async function call(
  deps: WorkspaceDeps,
  p: GooglePermiso,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const t = await token(deps, p);
  let res: Response;
  try {
    res = await googleFetch(deps, url, {
      ...init,
      headers: {
        authorization: `Bearer ${t}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Aviso('No llego a Google ahora mismo (¿sin conexión?). Prueba en un rato.');
  }
  if (res.status === 401 || res.status === 403) {
    const body = await res.text().catch(() => '');
    if (/has not been used|is disabled|accessNotConfigured|SERVICE_DISABLED/i.test(body)) {
      const api =
        p === 'drive'
          ? 'Google Drive API'
          : p === 'contacts'
            ? 'People API'
            : 'Google Calendar API';
      throw new Aviso(
        `Falta activar la «${api}» en tu proyecto de Google Cloud (console.cloud.google.com → APIs y servicios → Biblioteca). Pasos en docs/SETUP-INTEGRACIONES.md.`,
      );
    }
    throw new Aviso(faltaPermiso(p));
  }
  if (res.status === 404) throw new Aviso('Google dice que eso ya no existe (¿lo borraste?).');
  if (!res.ok) throw new Aviso(`Google ha respondido ${res.status}. Prueba en un rato.`);
  return res;
}

/** «2026-11-12T10:00» o «2026-11-12» → el formato de Calendar en la zona del dueño. */
export function calTime(
  value: string,
  tz: string,
): { date: string } | { dateTime: string; timeZone: string } {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { date: v };
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(v);
  if (!m) throw new Aviso(`No entiendo la fecha «${value}». Usa 2026-11-12T10:00 o 2026-11-12.`);
  return { dateTime: `${m[1]}T${m[2]?.padStart(2, '0')}:${m[3]}:00`, timeZone: tz };
}

function addHour(t: { date: string } | { dateTime: string; timeZone: string }) {
  if ('date' in t) {
    const d = new Date(`${t.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    // `d` es medianoche UTC: su día de calendario UTC es el que queremos (no el de Madrid).
    return { date: localDay(new Date(d.getTime() + 12 * 3_600_000)) };
  }
  const [day, hm] = t.dateTime.split('T');
  const [h = 0, mi = 0] = (hm ?? '').split(':').map(Number);
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMinutes(h * 60 + mi + 60);
  return { dateTime: `${d.toISOString().slice(0, 16)}:00`, timeZone: t.timeZone };
}

function cuando(e: Record<string, unknown>, tz: string): string {
  const s = (e.start ?? {}) as { date?: string; dateTime?: string };
  if (s.date) return `${s.date} (todo el día)`;
  if (!s.dateTime) return '';
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(s.dateTime));
}

export interface EventoArgs {
  titulo?: string;
  inicio?: string;
  fin?: string;
  lugar?: string;
  descripcion?: string;
  id?: string;
  texto?: string;
  desde?: string;
  hasta?: string;
}

async function run<T>(f: () => Promise<T>): Promise<T | string> {
  try {
    return await f();
  } catch (err) {
    if (err instanceof Aviso || err instanceof GoogleNotConnectedError) return err.message;
    if (err instanceof Error && err.message) return err.message;
    return 'No ha salido bien con Google.';
  }
}

export function crearEvento(deps: WorkspaceDeps, a: EventoArgs): Promise<string> {
  return run(async () => {
    if (!a.titulo?.trim() || !a.inicio)
      return 'Para apuntarlo necesito al menos el título y cuándo empieza.';
    const tz = (deps.timeZone ?? localTimeZone)();
    const start = calTime(a.inicio, tz);
    const end = a.fin ? calTime(a.fin, tz) : addHour(start);
    const res = await call(deps, 'calendarWrite', CAL_API, {
      method: 'POST',
      body: JSON.stringify({
        summary: a.titulo.trim(),
        start,
        end,
        ...(a.lugar ? { location: a.lugar } : {}),
        ...(a.descripcion ? { description: a.descripcion } : {}),
      }),
    });
    const e = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return `📅 Apuntado en tu Google Calendar: «${a.titulo.trim()}», ${cuando(e.start ? e : { start }, tz)}. (id ${String(e.id ?? '?')})`;
  });
}

export function moverEvento(deps: WorkspaceDeps, a: EventoArgs): Promise<string> {
  return run(async () => {
    if (!a.id || !a.inicio)
      return 'Para moverlo necesito el evento (id, búscalo antes) y la nueva hora.';
    const tz = (deps.timeZone ?? localTimeZone)();
    const start = calTime(a.inicio, tz);
    const end = a.fin ? calTime(a.fin, tz) : addHour(start);
    const res = await call(deps, 'calendarWrite', `${CAL_API}/${encodeURIComponent(a.id)}`, {
      method: 'PATCH',
      // Con el sitio si lo trae (una invitación que cambia de sala; bugs-38): si no, se queda.
      body: JSON.stringify({ start, end, ...(a.lugar ? { location: a.lugar } : {}) }),
    });
    const e = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return `📅 Movido: «${String(e.summary ?? 'el evento')}» ahora es ${cuando(e.start ? e : { start }, tz)}.`;
  });
}

export function borrarEvento(deps: WorkspaceDeps, a: EventoArgs): Promise<string> {
  return run(async () => {
    if (!a.id) return 'Para borrarlo necesito el evento (búscalo antes para tener su id).';
    await call(deps, 'calendarWrite', `${CAL_API}/${encodeURIComponent(a.id)}`, {
      method: 'DELETE',
    });
    return '🗑️ Borrado de tu Google Calendar.';
  });
}

export function buscarEventos(
  deps: WorkspaceDeps,
  a: EventoArgs,
  now = Date.now(),
): Promise<string> {
  return run(async () => {
    const tz = (deps.timeZone ?? localTimeZone)();
    const u = new URL(CAL_API);
    u.searchParams.set('singleEvents', 'true');
    u.searchParams.set('orderBy', 'startTime');
    u.searchParams.set('maxResults', '15');
    u.searchParams.set(
      'timeMin',
      a.desde ? new Date(a.desde).toISOString() : new Date(now - 86_400_000).toISOString(),
    );
    if (a.hasta) u.searchParams.set('timeMax', new Date(a.hasta).toISOString());
    if (a.texto?.trim()) u.searchParams.set('q', a.texto.trim());
    const res = await call(deps, 'calendar', u.toString());
    const items =
      ((await res.json().catch(() => ({}))) as { items?: Record<string, unknown>[] }).items ?? [];
    if (!items.length) return 'No encuentro eventos así en tu Google Calendar.';
    return items
      .map(
        (e) => `• ${String(e.summary ?? '(sin título)')} — ${cuando(e, tz)} (id ${String(e.id)})`,
      )
      .join('\n');
  });
}

/** Un evento que ya está en su Google Calendar (a su hora: «2026-11-20T09:30» o «2026-11-20»). */
export interface EventoGoogle {
  id: string;
  titulo: string;
  inicio: string;
  fin?: string;
  lugar?: string;
}

function aLocal(t: unknown, tz: string): string {
  const s = (t ?? {}) as { date?: string; dateTime?: string };
  if (s.date) return s.date;
  if (!s.dateTime) return '';
  const d = new Date(s.dateTime);
  if (!Number.isFinite(d.getTime())) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function aEvento(e: Record<string, unknown>, tz: string): EventoGoogle | null {
  if (typeof e.id !== 'string' || e.status === 'cancelled') return null;
  const inicio = aLocal(e.start, tz);
  if (!inicio) return null;
  const fin = aLocal(e.end, tz);
  return {
    id: e.id,
    titulo: String(e.summary ?? ''),
    inicio,
    ...(fin ? { fin } : {}),
    ...(typeof e.location === 'string' && e.location ? { lugar: e.location } : {}),
  };
}

const normTitulo = (t: string) =>
  t
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * ¿Ya está esta invitación en su Google Calendar? (Gmail suele añadirlas solo.) Primero por el
 * UID del .ics (Google lo guarda como iCalUID, también si lo añadió Gmail); si no, el mismo
 * título a la misma hora. Solo lee. `null` = no está; 'sin-acceso' = sin Google o sin permiso
 * de leer el calendario (o Google no responde): no se sabe, y quien llama sigue como antes.
 */
export async function eventoDeInvitacion(
  deps: WorkspaceDeps,
  q: { uid?: string; titulo: string; inicio: string },
): Promise<EventoGoogle | null | 'sin-acceso'> {
  const tz = (deps.timeZone ?? localTimeZone)();
  try {
    if (q.uid) {
      const u = new URL(CAL_API);
      u.searchParams.set('iCalUID', q.uid);
      u.searchParams.set('maxResults', '5');
      const res = await call(deps, 'calendar', u.toString());
      const items =
        ((await res.json().catch(() => ({}))) as { items?: Record<string, unknown>[] }).items ?? [];
      const evs = items.map((e) => aEvento(e, tz)).filter((e): e is EventoGoogle => e !== null);
      if (evs.length) return evs.find((e) => e.inicio === q.inicio) ?? evs[0] ?? null;
    }
    const dia = /^(\d{4}-\d{2}-\d{2})/.exec(q.inicio)?.[1];
    if (!dia || !q.titulo.trim()) return null;
    const desde = new Date(`${dia}T00:00:00Z`);
    const u = new URL(CAL_API);
    u.searchParams.set('singleEvents', 'true');
    u.searchParams.set('maxResults', '10');
    u.searchParams.set('q', q.titulo.trim());
    u.searchParams.set('timeMin', new Date(desde.getTime() - 86_400_000).toISOString());
    u.searchParams.set('timeMax', new Date(desde.getTime() + 2 * 86_400_000).toISOString());
    const res = await call(deps, 'calendar', u.toString());
    const items =
      ((await res.json().catch(() => ({}))) as { items?: Record<string, unknown>[] }).items ?? [];
    const t = normTitulo(q.titulo);
    return (
      items
        .map((e) => aEvento(e, tz))
        .find((e) => e !== null && e.inicio === q.inicio && normTitulo(e.titulo) === t) ?? null
    );
  } catch {
    return 'sin-acceso';
  }
}

let warmed = false;
export function resetWorkspaceForTests(): void {
  warmed = false;
}

export function buscarContacto(deps: WorkspaceDeps, texto: string): Promise<string> {
  return run(async () => {
    const q = texto.trim();
    if (!q) return 'Dime a quién busco.';
    const mask = 'names,emailAddresses,phoneNumbers';
    // La API pide una búsqueda vacía antes para calentar su caché (documentación de People).
    if (!warmed) {
      await call(deps, 'contacts', `${PEOPLE_API}/people:searchContacts?query=&readMask=${mask}`);
      warmed = true;
    }
    const res = await call(
      deps,
      'contacts',
      `${PEOPLE_API}/people:searchContacts?${new URLSearchParams({ query: q, readMask: mask, pageSize: '10' })}`,
    );
    const results =
      (
        (await res.json().catch(() => ({}))) as {
          results?: Array<{ person?: Record<string, unknown> }>;
        }
      ).results ?? [];
    if (!results.length) return `No tengo a «${q}» en tus contactos de Google.`;
    const vals = (p: Record<string, unknown>, k: string) =>
      (Array.isArray(p[k]) ? (p[k] as Array<Record<string, unknown>>) : [])
        .map((x) => String(x.value ?? x.displayName ?? ''))
        .filter(Boolean);
    return results
      .map(({ person = {} }) => {
        const name = vals(person, 'names')[0] ?? '(sin nombre)';
        const tel = vals(person, 'phoneNumbers');
        const mail = vals(person, 'emailAddresses');
        return `• ${name}${tel.length ? ` — 📞 ${tel.join(', ')}` : ''}${mail.length ? ` — ✉️ ${mail.join(', ')}` : ''}`;
      })
      .join('\n');
  });
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export function buscarDrive(deps: WorkspaceDeps, texto: string): Promise<string> {
  return run(async () => {
    const q = texto.trim();
    if (!q) return 'Dime qué busco en tu Drive.';
    const u = new URL(DRIVE_API);
    u.searchParams.set(
      'q',
      `(name contains '${esc(q)}' or fullText contains '${esc(q)}') and trashed = false`,
    );
    u.searchParams.set('pageSize', '10');
    u.searchParams.set('orderBy', 'modifiedTime desc');
    u.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime)');
    const res = await call(deps, 'drive', u.toString());
    const files =
      ((await res.json().catch(() => ({}))) as { files?: Record<string, unknown>[] }).files ?? [];
    if (!files.length) return `No encuentro «${q}» en tu Google Drive.`;
    return files
      .map(
        (f) =>
          `• ${String(f.name)} (${String(f.modifiedTime ?? '').slice(0, 10)}) id ${String(f.id)}`,
      )
      .join('\n');
  });
}

const EXPORT: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

export function leerDrive(deps: WorkspaceDeps, id: string): Promise<string> {
  return run(async () => {
    if (!id.trim()) return 'Dime qué archivo leo (búscalo antes para tener su id).';
    const base = `${DRIVE_API}/${encodeURIComponent(id.trim())}`;
    const meta = (await (
      await call(deps, 'drive', `${base}?fields=id,name,mimeType,size`)
    ).json()) as Record<string, unknown>;
    const mime = String(meta.mimeType ?? '');
    const exp = EXPORT[mime];
    let url = '';
    if (exp) url = `${base}/export?mimeType=${encodeURIComponent(exp)}`;
    else if (/^text\/|json|xml|csv|markdown/.test(mime)) url = `${base}?alt=media`;
    else
      return `«${String(meta.name)}» es un ${mime || 'archivo'} y solo leo documentos, hojas, presentaciones y texto. Si quieres, pásamelo por Telegram.`;
    const text = await (await call(deps, 'drive', url)).text();
    const cut =
      text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[… recortado: el archivo sigue]` : text;
    return `«${String(meta.name)}»:\n${cut}`;
  });
}
