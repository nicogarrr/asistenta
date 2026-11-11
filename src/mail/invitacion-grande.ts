/**
 * Invitaciones de calendario de un correo grande. El aviso de correo nuevo (IDLE) y la lectura
 * de un hilo piden la fuente cortada a 32 KB: con un cuerpo HTML grande (Outlook, Teams, Zoom)
 * el adjunto `.ics` va detrás y se perdía, y la invitación no salía («📅 Invitación: …»).
 * Con BODYSTRUCTURE se sabe qué parte es el calendario: si la fuente vino cortada y no trae
 * ninguno entero, se baja SOLO esa parte (como mucho 3, de 512 KB). Sin modelo y de solo lectura.
 */
import { calendarPartsOf } from './mime.js';

/** Lo que se pide de la fuente en IDLE y en la lectura de hilos. */
export const SOURCE_MAX_BYTES = 32_768;
const PART_MAX_BYTES = 512_000;

/** Lo que se lee de un nodo de BODYSTRUCTURE (imapflow). */
export interface CalendarStructNode {
  part?: string;
  type?: string;
  parameters?: Record<string, string>;
  dispositionParameters?: Record<string, string>;
  childNodes?: CalendarStructNode[];
}

/** Las partes (su número IMAP, «2», «1.3») que son una invitación: text/calendar, .ics. */
export function calendarPartIds(root: CalendarStructNode | undefined): string[] {
  const out: string[] = [];
  const walk = (node: CalendarStructNode | undefined, depth: number) => {
    if (!node || depth > 20 || out.length >= 3) return;
    if (node.childNodes?.length) {
      for (const child of node.childNodes) walk(child, depth + 1);
      return;
    }
    const type = (node.type ?? '').toLowerCase();
    const name = node.dispositionParameters?.filename ?? node.parameters?.name ?? '';
    const ics =
      type === 'text/calendar' ||
      type === 'application/ics' ||
      (/\.ics$/i.test(name) && (type === 'application/octet-stream' || type.startsWith('text/')));
    if (ics && node.part && /^\d+(?:\.\d+)*$/.test(node.part)) out.push(node.part);
  };
  walk(root, 0);
  return out;
}

/** ¿Hay que bajar aparte el calendario? Solo si la fuente vino cortada y no trae ninguno. */
export function calendarioCortado(
  source: Buffer | string | undefined,
  root: CalendarStructNode | undefined,
): string[] {
  const len = typeof source === 'string' ? Buffer.byteLength(source) : (source?.length ?? 0);
  if (len < SOURCE_MAX_BYTES) return [];
  const ids = calendarPartIds(root);
  if (!ids.length) return [];
  try {
    if (calendarPartsOf(source ?? '').length) return [];
  } catch {
    // Una fuente cortada que no se deja leer: se baja la parte.
  }
  return ids;
}

/** Lo mínimo del cliente IMAP que hace falta (imapflow `download`). */
export interface CalendarDownloader {
  download(
    range: string,
    part?: string,
    options?: { uid?: boolean; maxBytes?: number },
  ): Promise<{ content?: AsyncIterable<unknown> | null | undefined }>;
}

async function leer(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of stream) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
    chunks.push(b);
    total += b.length;
    if (total >= PART_MAX_BYTES) break;
  }
  return Buffer.concat(chunks).subarray(0, PART_MAX_BYTES);
}

/**
 * Baja esas partes (ya decodificadas por imapflow) y devuelve las que traen un VEVENT. Un
 * fallo no rompe el correo: sin invitación, como antes.
 */
export async function bajarCalendarios(
  client: CalendarDownloader,
  uid: number | string,
  ids: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids.slice(0, 3)) {
    try {
      const d = await client.download(String(uid), id, { uid: true, maxBytes: PART_MAX_BYTES });
      if (!d.content) continue;
      const text = (await leer(d.content)).toString('utf8');
      if (/BEGIN:VEVENT/i.test(text)) out.push(text);
    } catch {
      // Sigue con la siguiente.
    }
  }
  return out;
}
