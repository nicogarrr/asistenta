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

describe('franjas horarias tras una fecha (agenda)', () => {
  it('«de 10 a 12» y «de 16 a 18 h» dan la hora de inicio', () => {
    expect(at('Reunión el 4 de noviembre de 10 a 12')).toBe('2026-11-04 10:00');
    expect(at('Taller el 4/11 de 16 a 18 h')).toBe('2026-11-04 16:00');
    expect(at('Cita el 4 de noviembre, de 9:30 a 11')).toBe('2026-11-04 09:30');
  });

  it('«entre las 10 y las 12» da las 10', () => {
    expect(at('Reunión el 4 de noviembre entre las 10 y las 12')).toBe('2026-11-04 10:00');
  });

  it('una franja con «de la tarde» o con horas bajas se lee de tarde', () => {
    expect(at('Llamada el 4 de noviembre de 4 a 6 de la tarde')).toBe('2026-11-04 16:00');
    expect(at('Llamada el 4 de noviembre de 5 a 7')).toBe('2026-11-04 17:00');
  });

  it('«de 10 a 12 personas» no es una hora', () => {
    // Same as the date with no time at all.
    const untimed = at('Cena el 4 de noviembre');
    expect(at('Cena el 4 de noviembre para un grupo de 10 a 12 personas')).toBe(untimed);
    expect(at('Reunión el 4 de noviembre, presupuesto de 10 a 12 euros')).toBe(untimed);
  });
});
