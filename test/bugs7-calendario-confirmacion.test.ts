import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { confirmacionCalendario } from '../src/agenda/calendario-pasado.js';

// /calendario respondía «… — 2/11/2026, 10:00:00.»: con segundos y en la zona del
// ordenador, aunque PA_TIMEZONE dijera otra. Ahora «el 02/11 a las 10:00» en su zona.
const NOW = new Date('2026-11-01T10:00:00Z'); // domingo 1 nov, 11:00 en Madrid

describe('/calendario: confirmación al apuntar', () => {
  it('dice el día y la hora sin segundos', () => {
    const start = new Date('2026-11-05T09:30:00Z');
    expect(confirmacionCalendario('dentista', start, NOW, 'Europe/Madrid')).toBe(
      'Añadido al calendario local (no a Google): dentista — el 05/11 a las 10:30.',
    );
  });

  it('usa la zona configurada, no la del ordenador', () => {
    const start = new Date('2026-11-05T15:00:00Z');
    expect(confirmacionCalendario('llamada', start, NOW, 'America/New_York')).toContain(
      'el 05/11 a las 10:00.',
    );
  });

  it('hoy, mañana y otro año', () => {
    expect(
      confirmacionCalendario('a', new Date('2026-11-01T17:00:00Z'), NOW, 'Europe/Madrid'),
    ).toContain('— hoy a las 18:00.');
    expect(
      confirmacionCalendario('b', new Date('2026-11-02T08:05:00Z'), NOW, 'Europe/Madrid'),
    ).toContain('— mañana a las 09:05.');
    expect(
      confirmacionCalendario('c', new Date('2027-01-10T08:00:00Z'), NOW, 'Europe/Madrid'),
    ).toContain('— el 10/01/2027 a las 09:00.');
  });

  it('cli.ts ya no usa toLocaleString para la confirmación', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).not.toContain("start.toLocaleString('es-ES')");
    expect(cli).toContain('confirmacionCalendario(title, start, new Date())');
  });
});
