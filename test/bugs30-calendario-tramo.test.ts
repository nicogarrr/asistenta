import { describe, expect, it } from 'vitest';
import { confirmacionCalendario } from '../src/agenda/calendario-pasado.js';
import { parseTramoCalendario } from '../src/agenda/fecha-natural.js';
import { toIcsEvent } from '../src/agenda/write.js';

const TZ = 'Europe/Madrid';
// Jueves 5 de noviembre de 2026, 10:40 en Madrid.
const NOW = new Date('2026-11-05T09:40:00Z');
const hm = (d: Date) =>
  new Intl.DateTimeFormat('es-ES', {
    timeZone: TZ,
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);

describe('/calendario con un tramo («de 10 a 12»)', () => {
  it.each([
    ['mañana de 10 a 12 curso', '6, 10:00', '6, 12:00', 'curso'],
    ['curso mañana de 10 a 11:30', '6, 10:00', '6, 11:30', 'curso'],
    ['el viernes de 4 a 6 de la tarde tutoría', '6, 16:00', '6, 18:00', 'tutoría'],
    ['el lunes de 10 a 2 jornada', '9, 10:00', '9, 14:00', 'jornada'],
    ['mañana desde las 9 hasta las 13 examen', '6, 09:00', '6, 13:00', 'examen'],
    ['el 12 de 16:00 a 17:30 reunión con Pedro', '12, 16:00', '12, 17:30', 'reunión con Pedro'],
  ])('«%s» → %s–%s «%s»', (said, start, end, title) => {
    const r = parseTramoCalendario(said, NOW, TZ);
    expect(r && { start: hm(r.start), end: hm(r.end), title: r.title }).toEqual({
      start,
      end,
      title,
    });
  });

  it('sin tramo, o con otra hora fuera, no es un tramo', () => {
    expect(parseTramoCalendario('mañana a las 10 curso', NOW, TZ)).toBeNull();
    expect(parseTramoCalendario('reunión de 2 a 3 personas mañana a las 10', NOW, TZ)).toBeNull();
  });

  it('el evento lleva su hora de acabar y la confirmación dice el tramo', () => {
    const r = parseTramoCalendario('mañana de 10 a 12 curso', NOW, TZ);
    if (!r) throw new Error('sin tramo');
    expect(toIcsEvent({ title: r.title, start: r.start, end: r.end })).toContain(
      'DTEND:20261106T110000Z',
    );
    expect(confirmacionCalendario(r.title, r.start, NOW, TZ, r.end)).toBe(
      'Añadido al calendario local (no a Google): curso — mañana de 10:00 a 12:00.',
    );
  });
});
