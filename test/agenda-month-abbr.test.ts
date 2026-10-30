import { describe, expect, it } from 'vitest';
import { extractCommitments } from '../src/agenda/extract.js';

// Friday 30 Oct 2026, 10:00 in Madrid.
const now = Date.parse('2026-10-30T09:00:00Z');

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

describe('meses abreviados en el correo', () => {
  it('«15 nov», «15-nov», «4 de nov», «Nov 15» son fechas', () => {
    expect(at('Reunión el 15 nov a las 10:00')).toBe('2026-11-15 10:00');
    expect(at('Reunión el 15-nov a las 10:00')).toBe('2026-11-15 10:00');
    expect(at('Reunión el 4 de nov a las 10')).toBe('2026-11-04 10:00');
    expect(at('Meeting on Nov 15 at 3pm')).toBe('2026-11-15 15:00');
    expect(at('Cita el 9 de dic. a las 12:00')).toBe('2026-12-09 12:00');
  });

  it('«mar», «may» y «ago» solo cuentan detrás de «de»', () => {
    expect(at('Reunión el 4 de mar a las 10')).toBe('2027-03-04 10:00');
    expect(at('Ven el 4 may')).toBeUndefined();
    expect(at('Publicado hace 2 ago')).toBeUndefined();
    // «Mar 3 nov» es martes 3 de noviembre, no 3 de marzo.
    expect(at('Mar 3 nov reunión a las 10')).toBe('2026-11-03 10:00');
  });

  it('un número suelto delante de una palabra no es una fecha', () => {
    expect(at('Hace 2 días, 3 personas')).toBeUndefined();
  });
});
