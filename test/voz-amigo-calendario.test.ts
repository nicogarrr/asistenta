import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseFechaCalendario } from '../src/agenda/fecha-natural.js';
import { wallDateMinute } from '../src/datecontext.js';
import { formatServicesList } from '../src/services/store.js';

// Nico (1 nov): «como estamos hablando nosotros». /calendario pedía
// «/calendario add 2026-11-02 18:00 | Dentista»; ahora vale decirlo normal y la
// respuesta suelta a su pregunta lo apunta. Y «adopta <herramienta>» ya no sale.
const TZ = 'Europe/Madrid';
const NOW = new Date('2026-11-01T01:00:00Z'); // domingo 1 nov, 02:00 en Madrid
const said = (t: string) => {
  const r = parseFechaCalendario(t, NOW, TZ);
  return r ? `${wallDateMinute(r.start, TZ)} ${r.title}` : null;
};
const cli = readFileSync('src/cli.ts', 'utf8');

describe('/calendario dicho normal', () => {
  it('entiende días y horas como se dicen', () => {
    expect(said('mañana a las 18:00 dentista')).toBe('2026-11-02 18:00 dentista');
    expect(said('pasado mañana a las 9 llamar al taller')).toBe(
      '2026-11-03 09:00 llamar al taller',
    );
    expect(said('hoy 20:30, cena con Ana')).toBe('2026-11-01 20:30 cena con Ana');
    expect(said('el viernes a las 10 revisión del coche')).toBe(
      '2026-11-06 10:00 revisión del coche',
    );
    expect(said('el domingo a las 11 misa')).toBe('2026-11-08 11:00 misa');
    expect(said('el 2 de noviembre a las 18:00 Dentista')).toBe('2026-11-02 18:00 Dentista');
    expect(said('el 15 de enero a las 9 ITV')).toBe('2027-01-15 09:00 ITV');
    expect(said('el 3 a las 8 de la tarde pádel')).toBe('2026-11-03 20:00 pádel');
    expect(said('add 24/12 a las 21 Nochebuena')).toBe('2026-12-24 21:00 Nochebuena');
    expect(said('2026-11-20 a las 7 vuelo')).toBe('2026-11-20 07:00 vuelo');
  });

  it('lo que no encaja no se apunta', () => {
    for (const t of [
      '',
      'mañana dentista',
      'el 31 de noviembre a las 9 algo',
      'a las 25 nada',
      'mañana a las 18:00',
      '¿qué tengo mañana?',
    ]) {
      expect(said(t)).toBeNull();
    }
  });

  it('pregunta normal, sin «/calendario add … | …», y acepta la respuesta suelta', () => {
    expect(cli).not.toContain('/calendario add 2026-11-02 18:00 | Dentista');
    expect(cli).not.toContain('Escríbela así: 2026-11-02 18:00 | Dentista');
    expect(cli).toContain(
      "'¿Qué apunto y cuándo? Dímelo normal, por ejemplo «mañana a las 18:00 dentista» o «el viernes a las 10 revisión del coche».'",
    );
    expect(cli).toContain('answer: (t) => (parseFechaCalendario(t) ? `add ');
  });
});

describe('servicios: sin «adopta <herramienta>»', () => {
  it('la lista vacía da un ejemplo de verdad', () => {
    expect(formatServicesList([])).toBe(
      'No hay servicios adoptados. Si quieres alguno, dime cuál, por ejemplo «adopta Uptime Kuma», y te propongo el plan antes de instalar nada.',
    );
    expect(readFileSync('src/tools/service.ts', 'utf8')).not.toContain('adopta <herramienta>');
  });
});
