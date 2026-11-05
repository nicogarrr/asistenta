import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';

const TZ = 'Europe/Madrid';
// Jueves 5 de noviembre de 2026, 10:40 en Madrid.
const NOW = new Date('2026-11-05T09:40:00Z');
const at = (d: Date) =>
  new Intl.DateTimeFormat('es-ES', {
    timeZone: TZ,
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);

describe('/calendario: «esta noche cine a las 22» (la parte del día delante, la hora detrás)', () => {
  it.each([
    ['esta noche cine a las 22', '5, 22:00', 'cine'],
    ['esta noche cena con Ana a las 10', '5, 22:00', 'cena con Ana'],
    ['esta tarde pádel a las 7', '5, 19:00', 'pádel'],
    ['esta mañana médico a las 11:30', '5, 11:30', 'médico'],
    ['apunta esta tarde reunión a las 5:30', '5, 17:30', 'reunión'],
  ])('«%s» → %s «%s»', (said, when, title) => {
    const r = parseFechaCalendario(said, NOW, TZ);
    expect(r && { when: at(r.start), title: r.title }).toEqual({ when, title });
  });

  it('las formas que ya valían siguen igual', () => {
    const r = parseFechaCalendario('esta noche a las 10 cena', NOW, TZ);
    expect(r && { when: at(r.start), title: r.title }).toEqual({ when: '5, 22:00', title: 'cena' });
    const sinHora = parseFechaCalendario('esta noche cine', NOW, TZ);
    expect(sinHora && { when: at(sinHora.start), title: sinHora.title }).toEqual({
      when: '5, 21:00',
      title: 'cine',
    });
  });
});
