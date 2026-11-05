import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

// bugs29: /calendario «mañana sobre las 9 dentista» o «el viernes hacia las 18 cena» volvía a
// preguntar (la hora aproximada no se entendía); y «a las 21 y 2 personas cena» dejaba
// «y 2 personas cena» de título.
const now = new Date('2026-11-05T09:00:00+01:00'); // jueves
const local = (d: Date) =>
  d.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'short', timeStyle: 'short' });
const cal = (text: string) => {
  const r = parseFechaCalendario(text, now, 'Europe/Madrid');
  return r ? `${local(r.start)} | ${r.title}` : null;
};

describe('/calendario: hora aproximada y «y 2 personas» (bugs29)', () => {
  it('«sobre las 9», «hacia las 18», «a eso de las 10»', () => {
    expect(cal('mañana sobre las 9 dentista')).toBe('6/11/26, 9:00 | dentista');
    expect(cal('el viernes hacia las 18 cena con Ana')).toBe('6/11/26, 18:00 | cena con Ana');
    expect(cal('mañana a eso de las 10 llamar al banco')).toBe('6/11/26, 10:00 | llamar al banco');
    expect(cal('dentista mañana sobre las 9')).toBe('6/11/26, 9:00 | dentista');
  });

  it('el título sin el «y» de delante', () => {
    expect(cal('mañana a las 21 y 2 personas cena')).toBe('6/11/26, 21:00 | 2 personas cena');
    expect(cal('mañana a las 9 y media dentista')).toBe('6/11/26, 9:30 | dentista');
    expect(cal('mañana a las 9 dentista')).toBe('6/11/26, 9:00 | dentista');
  });
});
