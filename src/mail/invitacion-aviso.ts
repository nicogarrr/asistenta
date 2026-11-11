/**
 * «📅 Te ha llegado una invitación por correo… ¿La apunto?»: una invitación de calendario de
 * verdad (METHOD:REQUEST: una reunión a la que te invitan, no el .ics de un boletín) que llega
 * al correo trae ahora su botón de confirmar, como el .ics mandado por Telegram (#2368).
 * Antes solo se veía «📅 Invitación: …» en el texto del correo y apuntarla dependía de que el
 * agente lo pidiera. Sin modelo: los datos salen del propio .ics.
 *
 * «✅ Sí, apúntala» la crea UNA vez en su Google Calendar (si falla, ofrece el .ics);
 * «📲 .ics (iPhone)» manda el fichero para añadirla sin Google. Una tarjeta por evento, solo
 * de lo que aún no pasó, y «/invitacion off» las calla.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cuandoTexto, eventoArgs, localWallTime, yaPaso } from '../bandeja/evento.js';
import type { EventoArgs } from '../google/workspace.js';
import { parseIcs } from '../ics.js';
import { sliceSafe } from '../text.js';

/** Las que se recuerdan (las pasadas se limpian al escribir). */
const MAX = 50;

export interface InvitacionCorreo {
  clave: string;
  titulo: string;
  inicio: string;
  fin?: string;
  lugar?: string;
  de: string;
  asunto: string;
  avisada: number;
  apuntada?: boolean;
}

/** Misma invitación (mismo título y mismo inicio) = misma clave: un reenvío no avisa dos veces. */
export function claveInvitacion(titulo: string, inicio: string): string {
  return createHash('sha1')
    .update(`${titulo.trim().toLowerCase()}\u0000${inicio}`)
    .digest('hex')
    .slice(0, 10);
}

/**
 * Las invitaciones de un correo: METHOD:REQUEST, no canceladas, que aún no pasaron. Como
 * mucho 3.
 */
export function invitacionesDe(
  calendarios: readonly string[],
  m: { from: string; subject: string },
  tz: string,
  now: Date,
): InvitacionCorreo[] {
  const out: InvitacionCorreo[] = [];
  const ahora = localWallTime(now.toISOString(), tz);
  for (const raw of calendarios) {
    const { metodo, eventos } = parseIcs(raw);
    // Solo REQUEST (te invitan a una reunión). PUBLISH o sin METHOD es «añádelo si quieres»
    // (boletines, webs de eventos): ya sale en el texto del correo y no merece un aviso.
    if (metodo !== 'REQUEST') continue;
    for (const ev of eventos) {
      if (ev.cancelado) continue;
      const a = eventoArgs(ev, tz, null);
      if (!a.inicio || yaPaso(a, ahora)) continue;
      const clave = claveInvitacion(ev.nombre, a.inicio);
      if (out.some((x) => x.clave === clave)) continue;
      out.push({
        clave,
        titulo: sliceSafe(ev.nombre, 120),
        inicio: a.inicio,
        ...(a.fin ? { fin: a.fin } : {}),
        ...(ev.lugar ? { lugar: sliceSafe(ev.lugar, 120) } : {}),
        de: sliceSafe(m.from, 120),
        asunto: sliceSafe(m.subject, 120),
        avisada: now.getTime(),
      });
      if (out.length >= 3) return out;
    }
  }
  return out;
}

export class InvitacionesCorreo {
  readonly #file: string;
  constructor(file: string) {
    this.#file = file;
  }

  #leer(): { off?: boolean; lista: InvitacionCorreo[] } {
    try {
      const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as {
        off?: unknown;
        lista?: unknown;
      };
      const lista = Array.isArray(raw.lista)
        ? raw.lista.filter(
            (x): x is InvitacionCorreo =>
              !!x &&
              typeof x.clave === 'string' &&
              typeof x.titulo === 'string' &&
              typeof x.inicio === 'string',
          )
        : [];
      return { ...(raw.off === true ? { off: true } : {}), lista };
    } catch {
      return { lista: [] };
    }
  }

  #guardar(d: { off?: boolean; lista: InvitacionCorreo[] }): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(d, null, 2));
    renameSync(tmp, this.#file);
  }

  apagadas(): boolean {
    return this.#leer().off === true;
  }

  setApagadas(off: boolean): void {
    const d = this.#leer();
    this.#guardar(off ? { off: true, lista: d.lista } : { lista: d.lista });
  }

  get(clave: string): InvitacionCorreo | null {
    return this.#leer().lista.find((x) => x.clave === clave) ?? null;
  }

  /** Las que no se habían avisado (y las apunta como avisadas). Nada si están apagadas. */
  nuevas(cands: readonly InvitacionCorreo[], tz: string, now: Date): InvitacionCorreo[] {
    const d = this.#leer();
    if (d.off || !cands.length) return [];
    const ya = new Set(d.lista.map((x) => x.clave));
    const out = cands.filter((c) => !ya.has(c.clave));
    if (!out.length) return [];
    const ahora = localWallTime(now.toISOString(), tz);
    const vivas = d.lista.filter((x) => !yaPaso(x, ahora));
    this.#guardar({ ...d, lista: [...out, ...vivas].slice(0, MAX) });
    return out;
  }

  marcarApuntada(clave: string): void {
    const d = this.#leer();
    const i = d.lista.find((x) => x.clave === clave);
    if (!i) return;
    i.apuntada = true;
    this.#guardar(d);
  }
}

/** Los datos para crearla en Google Calendar (o para el .ics). */
export function argsDe(i: InvitacionCorreo): EventoArgs {
  return {
    titulo: i.titulo,
    inicio: i.inicio,
    ...(i.fin ? { fin: i.fin } : {}),
    ...(i.lugar ? { lugar: i.lugar } : {}),
    descripcion: `Invitación por correo de ${i.de}: «${i.asunto}»`,
  };
}

/** La tarjeta que llega a Telegram. Los botones los pone el daemon (claves de 10 hex). */
export function textoInvitacion(i: InvitacionCorreo): string {
  return [
    `📅 Te ha llegado una invitación por correo de ${i.de}:`,
    `«${i.titulo}» — ${cuandoTexto(argsDe(i))}${i.lugar ? ` · ${i.lugar}` : ''}`,
    '',
    '¿La apunto en tu Google Calendar? (Si ya la tienes, ignóralo; «/invitacion off» para no recibir estos avisos.)',
  ].join('\n');
}

/** «/invitacion apuntar <clave>», «/invitacion ics <clave>», «/invitacion off|on». */
export function invitacionOrden(
  args: string,
):
  | { kind: 'apuntar'; clave: string }
  | { kind: 'ics'; clave: string }
  | { kind: 'off' }
  | { kind: 'on' }
  | null {
  const a = args.trim().toLowerCase();
  if (/^(?:off|apagar|para|silenciar)$/.test(a)) return { kind: 'off' };
  if (/^(?:on|encender|activar)$/.test(a)) return { kind: 'on' };
  const m = /^(apuntar|ics)\s+([0-9a-f]{10})$/.exec(a);
  if (!m?.[2]) return null;
  return m[1] === 'ics' ? { kind: 'ics', clave: m[2] } : { kind: 'apuntar', clave: m[2] };
}
