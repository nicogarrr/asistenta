import { describe, expect, it } from 'vitest';
import { extractCommitments } from '../src/agenda/extract.js';

// «a las ocho» en un correo quedaba a las 09:00 (la hora por defecto): la hora escrita
// en letras no se leía. Ahora se lee igual que «a las 8».
const now = Date.parse('2026-10-30T09:00:00Z'); // viernes 30 oct, 10:00 en Madrid

function at(subject: string): string | undefined {
  const found = extractCommitments(
    [
      {
        id: 'm',
        from: 'ana@example.com',
        to: [],
        subject,
        text: '',
        at: now,
        seen: false,
        folder: 'INBOX',
      },
    ],
    { now, timeZone: 'Europe/Madrid', minConfidence: 0 },
  );
  const first = found[0];
  if (!first) return undefined;
  return new Date(first.at).toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 16);
}

describe('agenda: hora en letras en el correo', () => {
  it('«a las ocho», «a las doce» y «a la una»', () => {
    expect(at('Reunión el 4 de noviembre a las ocho')).toBe('2026-11-04 08:00');
    expect(at('Reunión el 4 de noviembre a las doce')).toBe('2026-11-04 12:00');
    expect(at('Cita el 4 de noviembre a la una')).toBe('2026-11-04 13:00');
  });

  it('con «y media», «menos cuarto» y la parte del día', () => {
    expect(at('Reunión el 4 de noviembre a las once y media')).toBe('2026-11-04 11:30');
    expect(at('Reunión el 4 de noviembre a las diez menos cuarto')).toBe('2026-11-04 09:45');
    expect(at('Reunión el 4 de noviembre a las cinco de la tarde')).toBe('2026-11-04 17:00');
    expect(at('Cena el 4 de noviembre a las nueve de la noche')).toBe('2026-11-04 21:00');
    expect(at('Cita el 4 de noviembre a la una y cuarto')).toBe('2026-11-04 13:15');
  });

  it('las horas bajas se leen de tarde, como «a las 3»', () => {
    expect(at('Llamada el 4 de noviembre a las tres con Ana')).toBe('2026-11-04 15:00');
  });

  it('«a las dos empresas» no es una hora', () => {
    expect(at('Reunión el 4 de noviembre: invitación a las dos empresas')).toBe('2026-11-04 09:00');
  });

  it('«a mediodía» y «al mediodía» son las 12:00', () => {
    expect(at('Comida el 4 de noviembre a mediodía')).toBe('2026-11-04 12:00');
    expect(at('Comida de empresa el 4 de noviembre al mediodía')).toBe('2026-11-04 12:00');
    expect(at('Cita el 4 de noviembre a las 2 del mediodía')).toBe('2026-11-04 14:00');
  });
});
