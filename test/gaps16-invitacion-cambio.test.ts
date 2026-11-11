import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandButton, commandFromCallback } from '../src/channels/telegram-shared.js';
import {
  InvitacionesCorreo,
  idDeGoogle,
  invitacionesDe,
  invitacionOrden,
  invitacionPasada,
  textoInvitacion,
} from '../src/mail/invitacion-aviso.js';

const TZ = 'Europe/Madrid';
const NOW = new Date('2026-11-11T18:00:00Z');
const MAIL = { from: 'ana@fondo.example', subject: 'Comité de inversión' };
const ics = (metodo: string, ini: string, fin: string, extra: string[] = []) =>
  [
    'BEGIN:VCALENDAR',
    `METHOD:${metodo}`,
    'BEGIN:VEVENT',
    'UID:comite-42@fondo.example',
    `DTSTART;TZID=Europe/Madrid:${ini}`,
    `DTEND;TZID=Europe/Madrid:${fin}`,
    'SUMMARY:Comité de inversión',
    ...extra,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
const PRIMERA = ics('REQUEST', '20261120T093000', '20261120T103000');
const MOVIDA = ics('REQUEST', '20261120T120000', '20261120T130000', ['SEQUENCE:1']);
const CANCELADA = ics('CANCEL', '20261120T120000', '20261120T130000', ['SEQUENCE:2']);

let dir = '';
let s: InvitacionesCorreo;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps16-invitacion-cambio-'));
  s = new InvitacionesCorreo(join(dir, 'invitaciones-correo.json'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const apuntarPrimera = () => {
  const [p] = s.nuevas(invitacionesDe([PRIMERA], MAIL, TZ, NOW), TZ, NOW);
  if (!p) throw new Error('sin tarjeta');
  s.marcarApuntada(p.clave, idDeGoogle('📅 Apuntado en tu Google Calendar: «Comité». (id abc123)'));
  return p;
};

describe('gaps-16: invitación por correo que cambia o se cancela (mismo UID)', () => {
  it('cambio de hora de una apuntada → «cámbiala» (mueve ESA, con su id de Google)', () => {
    const p = apuntarPrimera();
    expect(s.get(p.clave)).toMatchObject({
      apuntada: true,
      gid: 'abc123',
      uid: 'comite-42@fondo.example',
    });
    const [n] = s.nuevas(invitacionesDe([MOVIDA], MAIL, TZ, NOW), TZ, NOW);
    if (!n) throw new Error('sin tarjeta del cambio');
    expect(n.cambiaDe).toBe(p.clave);
    const previa = s.previa(n);
    expect(previa?.gid).toBe('abc123');
    expect(textoInvitacion(n, previa)).toContain(
      '📅 ana@fondo.example ha cambiado por correo una reunión que te apunté:',
    );
    expect(textoInvitacion(n, previa)).toContain('(antes: viernes 20 nov, 09:30–10:30)');
    const b = commandButton('✅ Sí, cámbiala', 'invitacion', n.clave, 'cambiar');
    expect(commandFromCallback(b?.action ?? '')).toBe(`/invitacion cambiar ${n.clave}`);
    expect(invitacionOrden(`cambiar ${n.clave}`)).toEqual({ kind: 'cambiar', clave: n.clave });
    // Movida: la nueva es la apuntada (mismo id), la vieja ya no.
    s.olvidarApuntada(p.clave);
    s.marcarApuntada(n.clave, 'abc123');
    const [c] = s.nuevas(invitacionesDe([CANCELADA], MAIL, TZ, NOW), TZ, NOW);
    expect(c).toMatchObject({ cancela: true, gid: 'abc123', cambiaDe: n.clave });
  });

  it('cancelación de una apuntada → «quítala»; de una que no se apuntó, nada', () => {
    expect(s.nuevas(invitacionesDe([CANCELADA], MAIL, TZ, NOW), TZ, NOW)).toEqual([]);
    const p = apuntarPrimera();
    const [c] = s.nuevas(invitacionesDe([CANCELADA], MAIL, TZ, NOW), TZ, NOW);
    if (!c) throw new Error('sin tarjeta de cancelación');
    expect(c).toMatchObject({ cancela: true, gid: 'abc123', cambiaDe: p.clave });
    expect(textoInvitacion(c, s.previa(c))).toContain(
      '❌ ana@fondo.example ha cancelado por correo una reunión que te apunté:',
    );
    const b = commandButton('🗑️ Sí, quítala', 'invitacion', c.clave, 'quitar');
    expect(commandFromCallback(b?.action ?? '')).toBe(`/invitacion quitar ${c.clave}`);
    // Y no repite.
    expect(s.nuevas(invitacionesDe([CANCELADA], MAIL, TZ, NOW), TZ, NOW)).toEqual([]);
  });

  it('una que no se apuntó y cambia: tarjeta normal de «apúntala»', () => {
    s.nuevas(invitacionesDe([PRIMERA], MAIL, TZ, NOW), TZ, NOW);
    const [n] = s.nuevas(invitacionesDe([MOVIDA], MAIL, TZ, NOW), TZ, NOW);
    if (!n) throw new Error('sin tarjeta');
    expect(n.cambiaDe).toBeUndefined();
    expect(textoInvitacion(n)).toContain('Te ha llegado una invitación');
  });

  it('un día suelto de una serie (RECURRENCE-ID sin la serie) no trae tarjeta', () => {
    const suelta = ics('REQUEST', '20261120T120000', '20261120T130000', [
      'RECURRENCE-ID;TZID=Europe/Madrid:20261120T093000',
    ]);
    expect(invitacionesDe([suelta], MAIL, TZ, NOW)).toEqual([]);
  });

  it('«✅» días después no apunta algo que ya pasó', () => {
    const [p] = invitacionesDe([PRIMERA], MAIL, TZ, NOW);
    if (!p) throw new Error('sin invitación');
    expect(invitacionPasada(p, TZ, NOW)).toBe(false);
    expect(invitacionPasada(p, TZ, new Date('2026-11-21T09:00:00Z'))).toBe(true);
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    const f = src.indexOf('const cmdInvitacion = async');
    const body = src.slice(f, f + 9000);
    expect(body).toContain('ya pasó; no la apunto.');
    expect(body).toContain('await moverEvento(ws, { ...iv.argsDe(inv), id: previa.gid })');
    expect(body).toContain('await borrarEvento(ws, { id: previa.gid })');
  });
});
