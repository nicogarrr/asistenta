/**
 * Las marcas del calendario de la bandeja (meta del store): qué cosa se apuntó, con qué id de
 * Google, qué invitación (UID) se apuntó con qué cosa y cuál se canceló. Las comparten
 * «📅 Al calendario» (comando.ts) y el resumen de la noche (resumen.ts), que no debe ofrecer
 * «📅 N calendario» de lo que ya no hay que apuntar (bugs-38).
 */
import type { EventoArgs } from '../google/workspace.js';
import type { BandejaItem, BandejaStore } from './store.js';

/** La cosa se apuntó con «✅ Sí, apúntalo» («inicio=<fecha>» con la que se apuntó). */
export const addedKey = (itemId: number) => `cal_added_${itemId}`;
/** El id del evento en su Google Calendar. */
export const gidKey = (itemId: number) => `cal_gid_${itemId}`;
/** UID de una invitación .ics → la cosa con la que se apuntó. */
export const uidKey = (chatId: string, uid: string) => `cal_uid_${chatId}_${uid}`;
/** UID de una invitación .ics → la cosa con su cancelación. */
export const cancelKey = (chatId: string, uid: string) => `cal_cancel_${chatId}_${uid}`;

type Evento = NonNullable<BandejaItem['extra']['evento']>;

/**
 * ¿Es la misma cita (mismo inicio y fin, y el mismo sitio si la nueva trae uno)? Entonces no
 * hay nada que cambiar. Una versión nueva sin sitio no borra el de antes.
 */
export function mismaCita(a: Evento | undefined, b: Evento): boolean {
  return mismaHora(a, b) && (!b.lugar || a?.lugar === b.lugar);
}

/** Mismo inicio y fin. */
export function mismaHora(a: Evento | undefined, b: Evento): boolean {
  return !!a && a.inicio === b.inicio && (a.fin ?? '') === (b.fin ?? '');
}

/**
 * ¿Tocar «📅 Al calendario» de esta cosa ya no apuntaría nada? Lo apuntado (con la misma
 * fecha), lo cancelado y la misma invitación ya apuntada con otra cosa a la misma hora. Lo que
 * cambió de fecha (o de sitio) no: tocarlo ofrece «✅ Sí, cámbialo».
 */
export function calendarioResuelto(
  store: Pick<BandejaStore, 'get' | 'getMeta'>,
  item: BandejaItem,
): boolean {
  const ev = item.extra.evento;
  if (!ev) return false;
  const uid = item.extra.icsUid;
  if (uid && store.getMeta(cancelKey(item.chatId, uid))) return true;
  if (versionPosterior(store, item)) return true;
  const marca = store.getMeta(addedKey(item.id));
  if (marca) {
    const conFecha = marca.startsWith('inicio=') ? marca.slice('inicio='.length) : null;
    if (conFecha === null || conFecha === ev.inicio) return true;
  }
  if (!uid) return false;
  const id = Number(store.getMeta(uidKey(item.chatId, uid)) ?? 0);
  if (!id || id === item.id || !store.getMeta(gidKey(id))) return false;
  const prev = store.get(id);
  return !!prev && prev.chatId === item.chatId && mismaCita(prev.extra.evento, ev);
}

/** Lo mismo con lo que se manda a Google (la hora local de eventoArgs, y el sitio). */
export function mismaHoraArgs(a: EventoArgs, b: EventoArgs): boolean {
  return a.inicio === b.inicio && (a.fin ?? '') === (b.fin ?? '');
}

export function mismaCitaArgs(a: EventoArgs, b: EventoArgs): boolean {
  return mismaHoraArgs(a, b) && (!b.lugar || a.lugar === b.lugar);
}

/**
 * La cosa de la bandeja con la que se apuntó la invitación de ese UID en ese chat (su id de
 * Google), si la hay: la tarjeta del correo no crea otro evento para la misma invitación.
 */
export function apuntadaEnBandeja(
  store: Pick<BandejaStore, 'get' | 'getMeta'>,
  chatId: string,
  uid: string,
): { item: BandejaItem; gid: string } | null {
  const id = Number(store.getMeta(uidKey(chatId, uid)) ?? 0);
  const item = id ? store.get(id) : null;
  const gid = item ? store.getMeta(gidKey(item.id)) : null;
  return item && gid && item.chatId === chatId && item.extra.evento ? { item, gid } : null;
}

/**
 * Una versión MÁS NUEVA de la misma invitación (su UID) que es la apuntada: esta es la vieja.
 * Tras «✅ Sí, cámbialo» la vieja seguía con «📅» en el resumen, y tocarla ofrecía devolver el
 * evento a la hora que ya no vale (bugs-38).
 */
export function versionPosterior(
  store: Pick<BandejaStore, 'get' | 'getMeta'>,
  item: BandejaItem,
): BandejaItem | null {
  const uid = item.extra.icsUid;
  if (!uid) return null;
  const id = Number(store.getMeta(uidKey(item.chatId, uid)) ?? 0);
  if (!id || id <= item.id || !store.getMeta(gidKey(id))) return null;
  const otra = store.get(id);
  return otra && otra.chatId === item.chatId && otra.extra.evento ? otra : null;
}
