import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InvitacionesCorreo,
  invitacionesDe,
  textoInvitacion,
} from '../src/mail/invitacion-aviso.js';

// bugs-38: una invitación por correo que solo cambia de SALA (misma hora; Outlook la reenvía)
// no avisaba: su clave era título+inicio, igual que la apuntada, así que se tomaba por un
// reenvío. En su calendario seguía el sitio viejo.
const TZ = 'Europe/Madrid';
const NOW = new Date('2026-11-11T18:00:00Z');
const MAIL = { from: 'ana@fondo.example', subject: 'Comité de inversión' };
const ics = (lugar: string | null, seq: number) =>
  [
    'BEGIN:VCALENDAR',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:comite-42@fondo.example',
    `SEQUENCE:${seq}`,
    'DTSTART;TZID=Europe/Madrid:20261120T093000',
    'DTEND;TZID=Europe/Madrid:20261120T103000',
    ...(lugar ? [`LOCATION:${lugar}`] : []),
    'SUMMARY:Comité de inversión',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

let dir = '';
let s: InvitacionesCorreo;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-bugs38-invitacion-sala-'));
  s = new InvitacionesCorreo(join(dir, 'invitaciones-correo.json'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('bugs-38: invitación por correo que cambia de sitio', () => {
  it('misma hora, otra sala → tarjeta «ha cambiado» con el sitio de antes', () => {
    const [p] = s.nuevas(invitacionesDe([ics('Sede, sala 2', 0)], MAIL, TZ, NOW), TZ, NOW);
    if (!p) throw new Error('sin tarjeta');
    s.marcarApuntada(p.clave, 'abc123');
    const [n] = s.nuevas(invitacionesDe([ics('IFEMA, sala 3', 1)], MAIL, TZ, NOW), TZ, NOW);
    if (!n) throw new Error('el cambio de sala no avisa');
    expect(n.cambiaDe).toBe(p.clave);
    expect(n.lugar).toBe('IFEMA, sala 3');
    const t = textoInvitacion(n, s.previa(n));
    expect(t).toContain('ha cambiado por correo una reunión que te apunté');
    expect(t).toContain('· IFEMA, sala 3 (antes: viernes 20 nov, 09:30–10:30 · Sede, sala 2)');
  });

  it('la misma invitación otra vez (misma sala, otro SEQUENCE) sigue sin avisar dos veces', () => {
    expect(s.nuevas(invitacionesDe([ics('Sede', 0)], MAIL, TZ, NOW), TZ, NOW)).toHaveLength(1);
    expect(s.nuevas(invitacionesDe([ics('Sede', 1)], MAIL, TZ, NOW), TZ, NOW)).toEqual([]);
  });
});
