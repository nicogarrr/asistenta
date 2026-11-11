/**
 * «📅 Al calendario» de la bandeja: la página de un congreso, un webinar, una junta de
 * accionistas o un concierto suele publicar su ficha schema.org `Event` (JSON-LD con
 * `startDate`, `endDate`, `location`). Se lee al procesar el enlace, sin modelo y gratis, y
 * la ficha de la cosa ofrece apuntarlo en su Google Calendar. Primero enseña qué va a
 * apuntar y solo lo apunta al pulsar «✅ Sí, apúntalo» (es un cambio en su calendario).
 */
import type { EventoArgs } from '../google/workspace.js';
import { sliceSafe } from '../text.js';
import { decodeEntities } from '../tools/fetch.js';

/** Lo que se guarda de la ficha (en `extra.evento`): fechas tal cual vienen (ISO). */
export interface BandejaEvento {
  nombre: string;
  inicio: string;
  fin?: string;
  lugar?: string;
}

const MAX = 120;
const clean = (s: string): string =>
  decodeEntities(s.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
const short = (s: string): string => (s.length > MAX ? `${sliceSafe(s, MAX - 1)}…` : s);

/** «2026-11-21» de una fecha a mediodía UTC (aritmética de días, no «hoy»). */
const ymdUtc = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

const DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function isEventType(t: unknown): boolean {
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => typeof x === 'string' && /(?:^|[/:])\w*Event$/.test(x));
}

function findEvent(data: unknown, depth = 0): Record<string, unknown> | null {
  if (!data || typeof data !== 'object' || depth > 6) return null;
  if (Array.isArray(data)) {
    for (const d of data) {
      const r = findEvent(d, depth + 1);
      if (r) return r;
    }
    return null;
  }
  const o = data as Record<string, unknown>;
  if (isEventType(o['@type'])) return o;
  return findEvent(o['@graph'], depth + 1);
}

function placeOf(loc: unknown): string | undefined {
  const first = Array.isArray(loc) ? loc[0] : loc;
  if (typeof first === 'string') return clean(first) || undefined;
  if (!first || typeof first !== 'object') return undefined;
  const o = first as Record<string, unknown>;
  if (/VirtualLocation$/.test(String(o['@type'] ?? '')))
    return typeof o.url === 'string' ? `En línea: ${o.url}` : 'En línea';
  const name = typeof o.name === 'string' ? clean(o.name) : '';
  const a = o.address;
  const addr =
    typeof a === 'string'
      ? clean(a)
      : a && typeof a === 'object'
        ? ['streetAddress', 'addressLocality', 'addressRegion']
            .map((k) => (a as Record<string, unknown>)[k])
            .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
            .map(clean)
            .join(', ')
        : '';
  const out = [name, addr].filter(Boolean).join(', ');
  return out || undefined;
}

/** La ficha `Event` de una página, si la publica con fecha de inicio (y no está cancelada). */
export function eventFromHtml(html: string): BandejaEvento | null {
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    let data: unknown;
    try {
      data = JSON.parse((m[1] ?? '').trim());
    } catch {
      continue;
    }
    const e = findEvent(data);
    if (!e) continue;
    if (/Cancelled$/i.test(String(e.eventStatus ?? ''))) continue;
    const inicio = typeof e.startDate === 'string' ? e.startDate.trim() : '';
    if (!DATE_RE.test(inicio)) continue;
    const nombre = typeof e.name === 'string' ? short(clean(e.name)) : '';
    if (!nombre) continue;
    const fin =
      typeof e.endDate === 'string' && DATE_RE.test(e.endDate.trim()) ? e.endDate.trim() : '';
    const lugar = placeOf(e.location);
    return {
      nombre,
      inicio,
      ...(fin ? { fin } : {}),
      ...(lugar ? { lugar: short(lugar) } : {}),
    };
  }
  return null;
}

/**
 * Una fecha de la ficha a la hora de Nico («2026-11-20T10:00» en su zona, o «2026-11-20» si
 * es de día entero). Con zona (Z, +01:00) se pasa a la suya; sin zona se toma tal cual.
 */
export function localWallTime(iso: string, tz: string): string {
  const v = iso.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const plain = /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(v);
  if (plain) return `${plain[1]}T${plain[2]?.padStart(2, '0')}:${plain[3]}`;
  const d = new Date(v.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (!Number.isFinite(d.getTime())) return v;
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

/** Los datos para crear el evento en su calendario (google/workspace.ts crearEvento). */
export function eventoArgs(ev: BandejaEvento, tz: string, url: string | null): EventoArgs {
  const inicio = localWallTime(ev.inicio, tz);
  let fin = ev.fin ? localWallTime(ev.fin, tz) : undefined;
  // Día entero: Google quiere el fin EXCLUSIVO (el día siguiente al último); crearEvento ya
  // pone +1 día si no hay fin. Con fin de día entero, se suma un día aquí.
  if (fin && /^\d{4}-\d{2}-\d{2}$/.test(fin)) {
    const d = new Date(`${fin}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    fin = ymdUtc(d);
  }
  // Un fin anterior o de otro tipo (día entero vs hora) no vale: mejor la hora por defecto.
  if (fin && (fin <= inicio || /T/.test(fin) !== /T/.test(inicio))) fin = undefined;
  return {
    titulo: ev.nombre,
    inicio,
    ...(fin ? { fin } : {}),
    ...(ev.lugar ? { lugar: ev.lugar } : {}),
    ...(url ? { descripcion: `Guardado desde la bandeja: ${url}` } : {}),
  };
}

/** «jueves 20 nov, 10:00–18:00» o «jueves 20 nov (todo el día)», en su hora. */
export function cuandoTexto(args: EventoArgs): string {
  const ini = args.inicio ?? '';
  const day = ini.slice(0, 10);
  const d = new Date(`${day}T12:00:00Z`);
  const fecha = Number.isFinite(d.getTime())
    ? new Intl.DateTimeFormat('es-ES', {
        timeZone: 'UTC',
        weekday: 'long',
        day: 'numeric',
        month: 'short',
      })
        .format(d)
        .replace(/\.$/, '')
        .replace(',', '')
    : day;
  if (!ini.includes('T')) {
    const fin = args.fin;
    if (fin) {
      const last = new Date(`${fin}T12:00:00Z`);
      last.setUTCDate(last.getUTCDate() - 1);
      const lastDay = ymdUtc(last);
      if (lastDay !== day)
        return `del ${fecha} al ${lastDay.slice(8, 10)}/${lastDay.slice(5, 7)} (todo el día)`;
    }
    return `${fecha} (todo el día)`;
  }
  const h = ini.slice(11, 16);
  const fin = args.fin && args.fin.slice(0, 10) === day ? `–${args.fin.slice(11, 16)}` : '';
  return `${fecha}, ${h}${fin}`;
}

/** ¿Ya pasó? (el fin, o el inicio si no hay fin), comparado en su hora local. */
export function yaPaso(args: EventoArgs, nowLocal: string): boolean {
  const ref = args.fin ?? args.inicio ?? '';
  if (!ref) return false;
  // Día entero: el fin es exclusivo; sin fin, el día de inicio entero cuenta.
  if (!ref.includes('T')) return (args.fin ? ref : `${ref}~`) <= nowLocal.slice(0, 10);
  return ref <= nowLocal;
}

/**
 * La línea del evento para la ficha y el resumen: «📅 jueves 20 nov, 10:00–18:00 · IFEMA,
 * Madrid», en su hora. Si ya pasó, lo dice («(ya pasó)») para que no lo busque en vano.
 * Antes la fecha solo salía al pulsar «📅 Al calendario»: en la ficha no se veía cuándo era.
 */
export function eventoLinea(ev: BandejaEvento, tz: string, now: Date): string {
  const args = eventoArgs(ev, tz, null);
  const paso = yaPaso(args, localWallTime(now.toISOString(), tz)) ? ' (ya pasó)' : '';
  return `📅 ${cuandoTexto(args)}${ev.lugar ? ` · ${ev.lugar}` : ''}${paso}`;
}
