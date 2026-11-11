import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvitacionesCorreo, invitacionesDe } from '../src/mail/invitacion-aviso.js';

// bugs-38: una reunión movida de 09:30 a 12:00 («✅ Sí, cámbiala») y luego devuelta a las
// 09:30 no avisaba: la vuelta tenía la misma clave (título+inicio) que la primera versión, se
// tomaba por un reenvío, y en su calendario se quedaba a las 12:00.
const TZ = 'Europe/Madrid';
const NOW = new Date('2026-11-11T18:00:00Z');
const MAIL = { from: 'ana@fondo.example', subject: 'Comité' };
const ics = (ini: string, fin: string, seq: number) =>
  [
    'BEGIN:VCALENDAR',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    'UID:comite-42@fondo.example',
    `SEQUENCE:${seq}`,
    `DTSTART;TZID=Europe/Madrid:${ini}`,
    `DTEND;TZID=Europe/Madrid:${fin}`,
    'SUMMARY:Comité de inversión',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
let dir = '';
let s: InvitacionesCorreo;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-bugs38-invitacion-vuelve-'));
  s = new InvitacionesCorreo(join(dir, 'invitaciones-correo.json'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const llega = (ini: string, fin: string, seq: number) =>
  s.nuevas(invitacionesDe([ics(ini, fin, seq)], MAIL, TZ, NOW), TZ, NOW);

describe('bugs-38: invitación por correo que vuelve a su hora de antes', () => {
  it('09:30 → 12:00 (cambiada) → 09:30 otra vez: avisa del cambio y apunta a la de las 12:00', () => {
    const [v1] = llega('20261120T093000', '20261120T103000', 0);
    if (!v1) throw new Error('sin tarjeta');
    s.marcarApuntada(v1.clave, 'abc123');
    const [v2] = llega('20261120T120000', '20261120T130000', 1);
    if (!v2) throw new Error('sin cambio');
    // «✅ Sí, cámbiala»: la nueva es la apuntada, la vieja ya no.
    s.olvidarApuntada(v1.clave);
    s.marcarApuntada(v2.clave, 'abc123');
    const [v3] = llega('20261120T093000', '20261120T103000', 2);
    expect(v3?.cambiaDe).toBe(v2.clave);
    expect(v3 && s.previa(v3)?.gid).toBe('abc123');
    expect(v3 && s.get(v3.clave)?.cambiaDe).toBe(v2.clave);
  });

  it('el mismo reenvío de la apuntada sigue sin avisar', () => {
    const [v1] = llega('20261120T093000', '20261120T103000', 0);
    if (!v1) throw new Error('sin tarjeta');
    s.marcarApuntada(v1.clave, 'abc123');
    expect(llega('20261120T093000', '20261120T103000', 1)).toEqual([]);
  });

  it('una que no se apuntó y vuelve a su hora: sin aviso nuevo (como antes)', () => {
    llega('20261120T093000', '20261120T103000', 0);
    llega('20261120T120000', '20261120T130000', 1);
    expect(llega('20261120T093000', '20261120T103000', 2)).toEqual([]);
  });
});
