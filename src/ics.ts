/**
 * Invitaciones de calendario (.ics, `text/calendar`, RFC 5545) leídas sin modelo y sin red.
 *
 * Una invitación de Google, Outlook o una web de eventos trae su fecha exacta en un VEVENT;
 * antes un .ics mandado por Telegram acababa en ⚠️ («ese tipo de documento no lo sé leer») y
 * en un correo era invisible (los adjuntos no se leen). Aquí se saca título, inicio, fin,
 * lugar y si es una cancelación, para enseñarlo y ofrecer «📅 Al calendario» (que pregunta
 * antes de apuntar nada).
 */
import { type BandejaEvento, eventoLinea } from './bandeja/evento.js';
import { sliceSafe } from './text.js';

export interface IcsEvento extends BandejaEvento {
  /** METHOD:CANCEL o STATUS:CANCELLED: es la cancelación de un evento, no una cita nueva. */
  cancelado?: boolean;
  /** Se repite (RRULE): se apunta solo la primera vez y se dice. */
  repite?: boolean;
}

/** La fuente (`extra.source`) de una cosa de la bandeja que es una invitación .ics. */
export const ICS_SOURCE = 'Invitación de calendario';

/** Tope de lo que se lee de un .ics (uno normal pesa pocos KB; un calendario entero, MB). */
export const ICS_MAX_CHARS = 512_000;
/** Eventos como mucho de un .ics (un calendario exportado entero no es una invitación). */
export const ICS_MAX_EVENTOS = 5;
const MAX = 120;

/** ¿Es un .ics por su tipo o su nombre? */
export function isIcsFile(mimeType?: string | null, name?: string | null): boolean {
  const m = (mimeType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (m === 'text/calendar' || m === 'application/ics' || m === 'text/x-vcalendar') return true;
  return /\.(ics|ical|ifb|vcs)$/i.test((name ?? '').trim());
}

/** Zonas de Windows (Outlook las pone en TZID) a IANA: las de quien escribe a Nico. */
const WINDOWS_TZ: Record<string, string> = {
  'romance standard time': 'Europe/Madrid',
  'w. europe standard time': 'Europe/Berlin',
  'central europe standard time': 'Europe/Budapest',
  'central european standard time': 'Europe/Warsaw',
  'gmt standard time': 'Europe/London',
  'greenwich standard time': 'Atlantic/Reykjavik',
  'gtb standard time': 'Europe/Bucharest',
  'e. europe standard time': 'Europe/Chisinau',
  'fle standard time': 'Europe/Kiev',
  'eastern standard time': 'America/New_York',
  'central standard time': 'America/Chicago',
  'mountain standard time': 'America/Denver',
  'pacific standard time': 'America/Los_Angeles',
  'sa pacific standard time': 'America/Bogota',
  'argentina standard time': 'America/Buenos_Aires',
  'e. south america standard time': 'America/Sao_Paulo',
  'mexico standard time': 'America/Mexico_City',
  'central standard time (mexico)': 'America/Mexico_City',
  'canary standard time': 'Atlantic/Canary',
  'morocco standard time': 'Africa/Casablanca',
  'china standard time': 'Asia/Shanghai',
  'tokyo standard time': 'Asia/Tokyo',
  'singapore standard time': 'Asia/Singapore',
  'india standard time': 'Asia/Kolkata',
  'arabian standard time': 'Asia/Dubai',
  utc: 'UTC',
  'coordinated universal time': 'UTC',
};

/** Una TZID usable por Intl, o null (Windows, «/mozilla.org/…/Europe/Madrid», comillas). */
export function ianaDe(tzid: string): string | null {
  const raw = tzid.replace(/^"|"$/g, '').trim();
  const win = WINDOWS_TZ[raw.toLowerCase()];
  const candidates = [win, raw, /([A-Za-z_]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(raw)?.[1]];
  for (const c of candidates) {
    if (!c) continue;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: c });
      return c;
    } catch {
      // siguiente
    }
  }
  return null;
}

/** El instante (ms UTC) de una hora de reloj en una zona (dos pasadas: aguanta el cambio de hora). */
function instanteEn(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  tz: string,
) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetAt = (t: number): number => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hourCycle: 'h23',
      })
        .formatToParts(new Date(t))
        .map((x) => [x.type, Number(x.value)]),
    ) as Record<string, number>;
    const asUtc = Date.UTC(
      p.year ?? y,
      (p.month ?? mo) - 1,
      p.day ?? d,
      p.hour ?? h,
      p.minute ?? mi,
      p.second ?? s,
    );
    return asUtc - t;
  };
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Una fecha de iCalendar al formato de la bandeja: «2026-11-20» (día entero),
 * «2026-11-20T08:30:00Z» (UTC o con su TZID pasada a UTC) o «2026-11-20T09:30» (flotante:
 * la hora de quien la lee). null si no se entiende.
 */
export function fechaIcs(value: string, params: Map<string, string>): string | null {
  const v = value.trim();
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (day) return `${day[1]}-${day[2]}-${day[3]}`;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(v);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '00'].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  if (m[7]) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${pad(s)}Z`;
  const tzid = params.get('tzid');
  const tz = tzid ? ianaDe(tzid) : null;
  if (tz) {
    const t = instanteEn(y, mo, d, h, mi, s, tz);
    return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
}

/** Quita los escapes de un TEXT de iCalendar (\, \; \n). */
function texto(v: string): string {
  const t = v
    .replace(/\\[nN]/g, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > MAX ? `${sliceSafe(t, MAX - 1)}…` : t;
}

interface Linea {
  name: string;
  params: Map<string, string>;
  value: string;
}

function lineas(raw: string): Linea[] {
  const unfolded = raw.slice(0, ICS_MAX_CHARS).replace(/\r?\n[ \t]/g, '');
  const out: Linea[] = [];
  for (const line of unfolded.split(/\r?\n/)) {
    // NOMBRE;PARAM=VALOR;PARAM="VA:LOR":valor — los dos puntos dentro de comillas no cortan.
    let i = 0;
    let quoted = false;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === '"') quoted = !quoted;
      else if (c === ':' && !quoted) break;
    }
    if (i >= line.length) continue;
    const [name = '', ...ps] = line.slice(0, i).split(';');
    const params = new Map<string, string>();
    for (const p of ps) {
      const eq = p.indexOf('=');
      if (eq > 0) params.set(p.slice(0, eq).trim().toLowerCase(), p.slice(eq + 1).trim());
    }
    out.push({ name: name.trim().toUpperCase(), params, value: line.slice(i + 1) });
  }
  return out;
}

/** Los eventos de un .ics (como mucho ICS_MAX_EVENTOS), y su METHOD si lo trae. */
export function parseIcs(raw: string): { metodo?: string; eventos: IcsEvento[] } {
  if (!/BEGIN:VCALENDAR|BEGIN:VEVENT/i.test(raw.slice(0, ICS_MAX_CHARS))) return { eventos: [] };
  let metodo: string | undefined;
  const eventos: IcsEvento[] = [];
  let cur: Map<string, Linea> | null = null;
  let depth = 0;
  for (const l of lineas(raw)) {
    if (l.name === 'METHOD' && !cur) metodo = l.value.trim().toUpperCase();
    if (l.name === 'BEGIN') {
      if (l.value.trim().toUpperCase() === 'VEVENT') {
        cur = new Map();
        depth = 0;
      } else if (cur) depth++;
      continue;
    }
    if (l.name === 'END') {
      if (cur && depth > 0) {
        depth--;
        continue;
      }
      if (cur && l.value.trim().toUpperCase() === 'VEVENT') {
        const ev = evento(cur, metodo);
        if (ev && !cur.has('RECURRENCE-ID')) eventos.push(ev);
        cur = null;
        if (eventos.length >= ICS_MAX_EVENTOS) break;
      }
      continue;
    }
    // Lo de dentro de un VALARM (depth > 0) no es del evento.
    if (cur && depth === 0 && !cur.has(l.name)) cur.set(l.name, l);
  }
  return { ...(metodo ? { metodo } : {}), eventos };
}

function evento(p: Map<string, Linea>, metodo?: string): IcsEvento | null {
  const ds = p.get('DTSTART');
  if (!ds) return null;
  const inicio = fechaIcs(ds.value, ds.params);
  if (!inicio) return null;
  const de = p.get('DTEND');
  let fin = de ? fechaIcs(de.value, de.params) : null;
  if (!fin) {
    // DURATION (PT1H30M, P1D): el fin a partir del inicio.
    const dur = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/i.exec(
      p.get('DURATION')?.value.trim() ?? '',
    );
    if (dur && /T/.test(inicio)) {
      const ms =
        ((Number(dur[1] ?? 0) * 7 + Number(dur[2] ?? 0)) * 24 * 60 +
          Number(dur[3] ?? 0) * 60 +
          Number(dur[4] ?? 0)) *
        60_000;
      const base = inicio.endsWith('Z') ? Date.parse(inicio) : Date.parse(`${inicio}:00Z`);
      if (ms > 0 && Number.isFinite(base)) {
        const iso = new Date(base + ms).toISOString();
        fin = inicio.endsWith('Z') ? iso.replace(/\.\d{3}Z$/, 'Z') : iso.slice(0, 16);
      }
    }
  }
  // Día entero: en iCalendar DTEND es EXCLUSIVO (un evento del 20 trae DTEND 21), pero el fin
  // de la bandeja es el último día, como el endDate de schema.org (eventoArgs suma el día que
  // pide Google). Sin restarlo, «el 20» salía «del viernes 20 nov al 21/11» y se apuntaba de
  // dos días (bugs-36).
  if (fin && /^\d{4}-\d{2}-\d{2}$/.test(fin) && /^\d{4}-\d{2}-\d{2}$/.test(inicio)) {
    const d = new Date(`${fin}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    const ultimo = d.toISOString().slice(0, 10);
    fin = ultimo > inicio ? ultimo : null;
  }
  const nombre = texto(p.get('SUMMARY')?.value ?? '') || 'Evento';
  const lugar = texto(p.get('LOCATION')?.value ?? '');
  const cancelado =
    metodo === 'CANCEL' || (p.get('STATUS')?.value.trim().toUpperCase() ?? '') === 'CANCELLED';
  return {
    nombre,
    inicio,
    ...(fin ? { fin } : {}),
    ...(lugar ? { lugar } : {}),
    ...(cancelado ? { cancelado: true } : {}),
    ...(p.has('RRULE') ? { repite: true } : {}),
  };
}

/**
 * Lo que dice de sus invitaciones un correo o un .ics, una línea por evento, en su hora:
 * «📅 Invitación: «Junta» — 📅 jueves 20 nov, 09:30–10:30 · IFEMA». Las repetidas y las
 * cancelaciones lo dicen. Vacío si no trae ninguna.
 */
export function invitacionLineas(
  textos: readonly string[],
  tz: string,
  now: Date = new Date(),
): string[] {
  const out: string[] = [];
  const vistos = new Set<string>();
  for (const t of textos) {
    for (const ev of parseIcs(t).eventos) {
      const key = `${ev.nombre}|${ev.inicio}`;
      if (vistos.has(key)) continue;
      vistos.add(key);
      const linea = eventoLinea(ev, tz, now);
      out.push(
        `${ev.cancelado ? '❌ Cancela' : '📅 Invitación'}: «${ev.nombre}» — ${linea.replace(/^📅 /, '')}${ev.repite ? ' (se repite)' : ''}`,
      );
    }
  }
  return out.slice(0, ICS_MAX_EVENTOS);
}
