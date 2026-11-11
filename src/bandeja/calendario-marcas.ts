/**
 * Las marcas del calendario de la bandeja (meta del store): qué cosa se apuntó, con qué id de
 * Google, qué invitación (UID) se apuntó con qué cosa y cuál se canceló. Las comparten
 * «📅 Al calendario» (comando.ts) y el resumen de la noche (resumen.ts), que no debe ofrecer
 * «📅 N calendario» de lo que ya no hay que apuntar (bugs-38).
 */
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
