// bugs-36 (revisión de gaps-15 #2368, invitaciones .ics): en iCalendar el DTEND de un evento
// de día entero es EXCLUSIVO (un evento del 20 trae DTEND 21), pero la bandeja guarda el
// último día (como el endDate de schema.org) y eventoArgs suma uno para Google. Una
// invitación de un solo día salía «del viernes 20 nov al 21/11» y se apuntaba de DOS días; el
// South Summit (2–3 dic) salía «al 04/12» y se apuntaba de tres.
import { describe, expect, it } from 'vitest';
import { cuandoTexto, eventoArgs } from '../src/bandeja/evento.js';
import { invitacionLineas, parseIcs } from '../src/ics.js';

const TZ = 'Europe/Madrid';
const NOW = new Date('2026-11-11T12:00:00Z');
const ics = (body: string) =>
  `BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\n${body}\r\nEND:VEVENT\r\nEND:VCALENDAR`;

describe('.ics de día entero: el DTEND es exclusivo', () => {
  it('un día: «viernes 20 nov (todo el día)» y a Google con fin el 21 (un solo día)', () => {
    const raw = ics('DTSTART;VALUE=DATE:20261120\r\nDTEND;VALUE=DATE:20261121\r\nSUMMARY:Junta');
    const [ev] = parseIcs(raw).eventos;
    if (!ev) throw new Error('sin evento');
    const args = eventoArgs(ev, TZ, null);
    expect(cuandoTexto(args)).toBe('viernes 20 nov (todo el día)');
    expect(args.inicio).toBe('2026-11-20');
    // Sin fin, crearEvento pone el día siguiente (exclusivo): un día.
    expect(args.fin === undefined || args.fin === '2026-11-21').toBe(true);
    expect(invitacionLineas([raw], TZ, NOW)[0]).toContain('viernes 20 nov (todo el día)');
  });

  it('varios días: 2–3 dic sale «al 03/12» y a Google con fin el 4', () => {
    const raw = ics(
      'DTSTART;VALUE=DATE:20261202\r\nDTEND;VALUE=DATE:20261204\r\nSUMMARY:South Summit',
    );
    const [ev] = parseIcs(raw).eventos;
    if (!ev) throw new Error('sin evento');
    const args = eventoArgs(ev, TZ, null);
    expect(args).toMatchObject({ inicio: '2026-12-02', fin: '2026-12-04' });
    expect(cuandoTexto(args)).toContain('03/12');
    expect(cuandoTexto(args)).not.toContain('04/12');
  });

  it('con hora no cambia nada', () => {
    const [ev] = parseIcs(
      ics('DTSTART:20261120T083000Z\r\nDTEND:20261120T093000Z\r\nSUMMARY:Call'),
    ).eventos;
    expect(ev?.fin).toBe('2026-11-20T09:30:00Z');
  });
});
