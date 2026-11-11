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
 *
 * Con el UID del .ics (el mismo en todas las versiones de una reunión): si la que se apuntó
 * cambia de hora, la tarjeta nueva ofrece «✅ Sí, cámbiala» (mueve ESE evento, no crea otro);
 * si se cancela, «🗑️ Sí, quítala». Una cancelación de algo que no se apuntó no avisa (ya sale
 * «❌ Cancela» en el texto del correo).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { apuntadaEnBandeja, mismaCitaArgs } from '../bandeja/calendario-marcas.js';
import { cuandoTexto, eventoArgs, localWallTime, yaPaso } from '../bandeja/evento.js';
import type { BandejaStore } from '../bandeja/store.js';
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
  /** UID del .ics: el mismo en la invitación, sus cambios y su cancelación. */
  uid?: string;
  /** Id del evento en Google Calendar, cuando se apuntó con «✅» (para moverlo o quitarlo). */
  gid?: string;
  /** Es la cancelación de una que se apuntó. */
  cancela?: boolean;
  /** Es un cambio de hora de la que se apuntó (su clave): «✅ Sí, cámbiala». */
  cambiaDe?: string;
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
    // CANCEL solo sirve si se apuntó antes (el almacén lo casa por UID).
    if (metodo !== 'REQUEST' && metodo !== 'CANCEL') continue;
    for (const ev of eventos) {
      // Un día suelto de una serie (RECURRENCE-ID sin la serie): apuntarlo crearía un evento
      // aparte del de la serie; se queda en el texto del correo.
      if (ev.ocurrencia) continue;
      const cancela = metodo === 'CANCEL' || ev.cancelado === true;
      if (cancela && !ev.uid) continue;
      const a = eventoArgs(ev, tz, null);
      if (!a.inicio || yaPaso(a, ahora)) continue;
      // Con el sitio: una versión que solo cambia de sala (Outlook la reenvía) es un cambio, no
      // un reenvío (bugs-38). Sin sitio, la clave de siempre.
      const clave = claveInvitacion(
        ev.nombre,
        cancela ? `${a.inicio}#cancela` : ev.lugar ? `${a.inicio}@${ev.lugar.trim()}` : a.inicio,
      );
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
        ...(ev.uid ? { uid: ev.uid } : {}),
        ...(cancela ? { cancela: true } : {}),
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

  /**
   * Las que no se habían avisado (y las apunta como avisadas). Nada si están apagadas. Una
   * cancelación solo sale si se apuntó la de ese UID (y entonces lleva su `gid`); un cambio de
   * hora de una apuntada lleva `cambiaDe`.
   */
  nuevas(cands: readonly InvitacionCorreo[], tz: string, now: Date): InvitacionCorreo[] {
    const d = this.#leer();
    if (d.off || !cands.length) return [];
    const ya = new Set(d.lista.map((x) => x.clave));
    const apuntadaDe = (uid: string | undefined) =>
      uid ? d.lista.find((x) => x.uid === uid && x.apuntada && x.gid && !x.cancela) : undefined;
    const out: InvitacionCorreo[] = [];
    for (const c of cands) {
      const previa = apuntadaDe(c.uid);
      // Ya avisada… salvo que la apuntada de su UID sea OTRA versión: una reunión movida y
      // luego devuelta a su hora tiene la clave de la primera, y se tomaba por un reenvío
      // (en su calendario se quedaba la hora del medio; bugs-38).
      if (ya.has(c.clave) && (c.cancela || !previa || previa.clave === c.clave)) continue;
      if (c.cancela) {
        if (previa) out.push({ ...c, gid: previa.gid, cambiaDe: previa.clave });
        continue;
      }
      out.push(previa ? { ...c, cambiaDe: previa.clave } : c);
    }
    if (!out.length) return [];
    const ahora = localWallTime(now.toISOString(), tz);
    const nuevasClaves = new Set(out.map((x) => x.clave));
    const vivas = d.lista.filter((x) => !yaPaso(x, ahora) && !nuevasClaves.has(x.clave));
    this.#guardar({ ...d, lista: [...out, ...vivas].slice(0, MAX) });
    return out;
  }

  /** Apuntada en Google con ese id. */
  marcarApuntada(clave: string, gid?: string | null): void {
    const d = this.#leer();
    const i = d.lista.find((x) => x.clave === clave);
    if (!i) return;
    i.apuntada = true;
    if (gid) i.gid = gid;
    this.#guardar(d);
  }

  /**
   * La previa ya no está en el calendario (se movió a la nueva, se quitó o la borró él): deja
   * de contar como apuntada.
   */
  olvidarApuntada(clave: string): void {
    const d = this.#leer();
    const i = d.lista.find((x) => x.clave === clave);
    if (!i) return;
    i.apuntada = false;
    delete i.gid;
    this.#guardar(d);
  }

  /**
   * La apuntada con la tarjeta del correo (con su id de Google) de ese UID, si la hay: el mismo
   * .ics por Telegram (la bandeja) no crea otro evento (bugs-38).
   */
  apuntadaPorUid(uid: string): InvitacionCorreo | null {
    return (
      this.#leer().lista.find((x) => x.uid === uid && x.apuntada && x.gid && !x.cancela) ?? null
    );
  }

  /** La apuntada (con su id de Google) a la que se refiere un cambio o una cancelación. */
  previa(i: InvitacionCorreo): InvitacionCorreo | null {
    if (!i.cambiaDe) return null;
    const p = this.get(i.cambiaDe);
    return p?.apuntada && p.gid ? p : null;
  }
}

/** El id que Google dio al evento («📅 Apuntado … (id abc123)», google/workspace.ts). */
export function idDeGoogle(text: string): string | null {
  const id = /\(id ([^\s)]+)\)\s*$/.exec(text)?.[1];
  return id && id !== '?' ? id : null;
}

/** «el viernes 20 nov, 09:30–10:30» de la invitación. */
export function cuandoDe(i: InvitacionCorreo): string {
  return cuandoTexto(argsDe(i));
}

/** ¿Ya pasó? (tocar «✅» días después no apunta algo de ayer). */
export function invitacionPasada(i: InvitacionCorreo, tz: string, now: Date): boolean {
  return yaPaso(i, localWallTime(now.toISOString(), tz));
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
export function textoInvitacion(i: InvitacionCorreo, previa?: InvitacionCorreo | null): string {
  const linea = `«${i.titulo}» — ${cuandoTexto(argsDe(i))}${i.lugar ? ` · ${i.lugar}` : ''}`;
  if (i.cancela)
    return [
      `❌ ${i.de} ha cancelado por correo una reunión que te apunté:`,
      linea,
      '',
      '¿La quito de tu Google Calendar?',
    ].join('\n');
  if (previa)
    return [
      `📅 ${i.de} ha cambiado por correo una reunión que te apunté:`,
      `${linea} (antes: ${cuandoTexto(argsDe(previa))}${previa.lugar && previa.lugar !== i.lugar ? ` · ${previa.lugar}` : ''})`,
      '',
      '¿La cambio en tu Google Calendar? (Muevo la que ya tienes; no creo otra.)',
    ].join('\n');
  return [
    `📅 Te ha llegado una invitación por correo de ${i.de}:`,
    linea,
    '',
    '¿La apunto en tu Google Calendar? (Si ya la tienes, ignóralo; «/invitacion off» para no recibir estos avisos.)',
  ].join('\n');
}

/** «/invitacion apuntar|cambiar|quitar|ics <clave>», «/invitacion off|on». */
export function invitacionOrden(
  args: string,
):
  | { kind: 'apuntar' | 'cambiar' | 'quitar' | 'ics'; clave: string }
  | { kind: 'off' }
  | { kind: 'on' }
  | null {
  const a = args.trim().toLowerCase();
  if (/^(?:off|apagar|para|silenciar)$/.test(a)) return { kind: 'off' };
  if (/^(?:on|encender|activar)$/.test(a)) return { kind: 'on' };
  const m = /^(apuntar|cambiar|quitar|ics)\s+([0-9a-f]{10})$/.exec(a);
  const kind = m?.[1];
  if (!m?.[2] || (kind !== 'apuntar' && kind !== 'cambiar' && kind !== 'quitar' && kind !== 'ics'))
    return null;
  return { kind, clave: m[2] };
}

/**
 * «✅ Sí, apúntala» de una invitación del correo que ya se apuntó por la bandeja (el mismo .ics
 * mandado por Telegram, mismo UID): antes creaba un segundo evento (bugs-38). Si es la misma
 * cita, «ya está»; si cambió, mueve el que hay. null: no estaba (o lo borró él), se crea.
 * `gid`: el evento de Google con el que queda apuntada (null si mover falló).
 */
export async function apuntarSiEnBandeja(
  inv: InvitacionCorreo,
  bandeja: Pick<BandejaStore, 'get' | 'getMeta'>,
  chatId: string,
  tz: string,
  mover: (gid: string, args: EventoArgs) => Promise<string>,
): Promise<{ text: string; gid: string | null } | null> {
  const previa = inv.uid ? apuntadaEnBandeja(bandeja, chatId, inv.uid) : null;
  const ev = previa?.item.extra.evento;
  if (!previa || !ev) return null;
  const antes = eventoArgs(ev, tz, previa.item.url);
  const ahora = argsDe(inv);
  if (mismaCitaArgs(antes, ahora))
    return {
      text: `📅 «${inv.titulo}» ya está en tu Google Calendar (la apunté con la #${previa.item.id} de la bandeja).`,
      gid: previa.gid,
    };
  const text = await mover(previa.gid, ahora);
  if (/ya no existe|respondido 4(?:04|10)/.test(text)) return null;
  if (!text.startsWith('📅 Movido')) return { text, gid: null };
  return {
    text: `📅 Cambiada en tu Google Calendar: «${inv.titulo}», ahora ${cuandoDe(inv)}${inv.lugar ? ` · ${inv.lugar}` : ''} (era la que apunté con la #${previa.item.id} de la bandeja; no creo otra).`,
    gid: previa.gid,
  };
}
