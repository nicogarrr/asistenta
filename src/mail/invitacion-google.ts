/**
 * Antes de ofrecer «✅ Sí, apúntala» para una invitación que llega al correo, mirar si ya está en
 * su Google Calendar: Gmail suele añadir las invitaciones solo, y la tarjeta acababa en dos
 * eventos iguales. Si ya está (mismo UID del .ics, o el mismo título a la misma hora) se dice
 * «ya está» sin botón; si está con ese UID pero a otra hora, se dice también (sin crear otra).
 * Sin Google conectado, o sin permiso de leer, todo sigue como antes.
 */
import { cuandoTexto } from '../bandeja/evento.js';
import type { EventoGoogle } from '../google/workspace.js';
import { cuandoDe, type InvitacionCorreo } from './invitacion-aviso.js';

export type ConGoogle =
  | { kind: 'normal' }
  | { kind: 'ya'; ev: EventoGoogle }
  | { kind: 'otra-hora'; ev: EventoGoogle };

/**
 * Solo para una invitación nueva (no un cambio ni una cancelación de algo que apuntó Asistenta:
 * esas ya tienen su id de Google y su botón).
 */
export function decidirConGoogle(
  inv: InvitacionCorreo,
  previa: InvitacionCorreo | null | undefined,
  ev: EventoGoogle | null | 'sin-acceso',
): ConGoogle {
  if (inv.cancela || previa || !ev || ev === 'sin-acceso') return { kind: 'normal' };
  if (ev.inicio === inv.inicio) return { kind: 'ya', ev };
  return { kind: 'otra-hora', ev };
}

function cuandoEv(ev: EventoGoogle): string {
  return cuandoTexto({ inicio: ev.inicio, ...(ev.fin ? { fin: ev.fin } : {}) });
}

/** El aviso cuando ya está en su calendario (sin botón de apuntar). */
export function textoYaEnCalendario(
  inv: InvitacionCorreo,
  d: Exclude<ConGoogle, { kind: 'normal' }>,
): string {
  const linea = `«${inv.titulo}» — ${cuandoDe(inv)}${inv.lugar ? ` · ${inv.lugar}` : ''}`;
  return [
    `📅 Te ha llegado una invitación por correo de ${inv.de}:`,
    linea,
    '',
    d.kind === 'ya'
      ? '✅ Ya está en tu Google Calendar (seguramente la añadió Gmail), así que no la apunto otra vez.'
      : `Ya la tienes en tu Google Calendar, pero para el ${cuandoEv(d.ev)}. Gmail suele ponerla al día solo; si no, cámbiala allí. No creo otra.`,
  ].join('\n');
}
