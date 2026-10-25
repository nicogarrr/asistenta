/**
 * Escritura de calendario local en iCalendar (`.ics`).
 *
 * El calendario del agente era de solo lectura: leía una URL secreta y respondía
 * "qué tengo". Esto añade la otra mitad, sin integrarse con Google ni con ninguna
 * cuenta: un fichero local que cualquier cliente puede importar. Es deliberadamente
 * mínimo (RFC 5545): VCALENDAR, VEVENT, UID estable, fechas en UTC y texto escapado.
 *
 * Decisiones:
 * - `DTSTART` y `DTEND` siempre en UTC (`...Z`). Un evento creado en Madrid se lee
 *   igual desde otro equipo, y el cliente no tiene que resolver una zona.
 * - Sin `end` no se inventa una duración: se omite DTEND (RFC 5545 §3.6.1: dura cero).
 * - `uid` explícito manda; si falta se deriva de título + inicio, así repetir la misma
 *   escritura no crea una identidad nueva.
 * - `DTSTAMP` usa el inicio del evento para que la salida sea reproducible; no es la
 *   hora de creación, pero es un valor UTC válido y los tests pueden comparar bytes.
 * - El añadido relee el fichero y escribe temporal + rename: nunca se queda a medias
 *   ni duplica la cabecera VCALENDAR.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface IcsEvent {
  uid?: string;
  title: string;
  start: Date;
  end?: Date;
  location?: string;
  description?: string;
}

const CALENDAR_HEADER = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Asistenta//ES',
  'CALSCALE:GREGORIAN',
];

const CALENDAR_FOOTER = 'END:VCALENDAR';

/** `20261025T100000Z`, el único formato de fecha que escribe este módulo. */
function utcStamp(date: Date, label: string): string {
  if (Number.isNaN(date.getTime())) throw new Error(`${label} no es una fecha válida`);
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** Escapa un valor TEXT de RFC 5545: barra, salto de línea, punto y coma y coma. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function uidFor(event: IcsEvent, title: string): string {
  const explicit = (event.uid ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 200);
  if (explicit) return escapeText(explicit);
  const hash = createHash('sha1')
    .update(`${title}\u0000${event.start.toISOString()}`)
    .digest('hex')
    .slice(0, 20);
  return `${hash}@asistenta.local`;
}

/**
 * Un VEVENT completo, con líneas CRLF y sin VCALENDAR: `appendEvent` es quien decide
 * si hay que envolverlo. No se pliega a 75 octetos; es la relajación práctica que
 * todos los clientes aceptan y evita partir justo el texto que el usuario escribió.
 */
export function toIcsEvent(event: IcsEvent): string {
  const title = event.title.replace(/\r\n|\r/g, '\n').trim();
  if (!title) throw new Error('el evento necesita un título');

  const start = utcStamp(event.start, 'start');
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uidFor(event, title)}`,
    `DTSTAMP:${start}`,
    `DTSTART:${start}`,
  ];

  if (event.end) {
    const end = event.end.getTime();
    if (Number.isNaN(end)) throw new Error('end no es una fecha válida');
    if (end < event.start.getTime()) throw new Error('end no puede ser anterior a start');
    lines.push(`DTEND:${utcStamp(event.end, 'end')}`);
  }

  lines.push(`SUMMARY:${escapeText(title)}`);

  const location = (event.location ?? '').replace(/\r\n|\r|\n/g, ' ').trim();
  if (location) lines.push(`LOCATION:${escapeText(location)}`);

  const description = (event.description ?? '').trim();
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);

  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\n');
}

/** Escribe de forma atómica: el fichero anterior sobrevive a cualquier fallo. */
async function writeAtomic(file: string, contents: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } catch (err) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Añade un evento al calendario local, creándolo si no existe. Si el fichero ya tiene
 * VCALENDAR, el VEVENT se inserta antes del último `END:VCALENDAR`; si le falta la
 * cabecera, se envuelve el contenido existente en vez de descartarlo.
 */
export async function appendEvent(file: string, event: IcsEvent): Promise<void> {
  const block = toIcsEvent(event);

  let existing = '';
  try {
    existing = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const normalized = normalizeNewlines(existing).trimEnd();
  let body: string;
  if (!normalized) {
    body = [...CALENDAR_HEADER, block, CALENDAR_FOOTER].join('\n');
  } else {
    const upper = normalized.toUpperCase();
    const begin = upper.indexOf('BEGIN:VCALENDAR');
    const end = upper.lastIndexOf('END:VCALENDAR');
    if (begin >= 0 && end > begin) {
      const before = normalized.slice(0, end);
      const glue = before.endsWith('\n') ? '' : '\n';
      body = `${before}${glue}${block}\n${normalized.slice(end)}`;
    } else if (begin >= 0) {
      // Cabecera sin cierre (fichero truncado): se repara al añadir.
      body = `${normalized}\n${block}\n${CALENDAR_FOOTER}`;
    } else {
      // Contenido suelto o fichero de otro formato: se conserva y se envuelve.
      body = [...CALENDAR_HEADER, normalized, block, CALENDAR_FOOTER].join('\n');
    }
  }

  const contents = `${normalizeNewlines(body).replace(/\n/g, '\r\n')}\r\n`;
  await writeAtomic(file, contents);
}
