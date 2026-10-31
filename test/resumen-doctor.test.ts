/**
 * Primer uso: quien activaba el resumen de la mañana no tenía forma de saber si
 * Asistenta lo había entendido (hora, tiempo). Ahora `pa doctor` lo dice, y si un
 * valor del .env no se entiende, avisa en castellano.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { briefingDoctorLine } from '../src/briefing-env.js';

describe('pa doctor: resumen de la mañana', () => {
  it('apagado: dice cómo encenderlo', () => {
    expect(briefingDoctorLine({})).toMatch(/^resumen +apagado \(pon PA_BRIEFING=1/);
    expect(briefingDoctorLine({ PA_BRIEFING: '0' })).toMatch(/apagado/);
  });

  it('valor que no se entiende: lo dice', () => {
    expect(briefingDoctorLine({ PA_BRIEFING: 'vale' })).toMatch(
      /^resumen +PA_BRIEFING «vale» no se entiende: pon 1/,
    );
  });

  it('encendido: hora y tiempo', () => {
    expect(
      briefingDoctorLine({
        PA_BRIEFING: 'sí',
        PA_BRIEFING_HOUR: '7',
        PA_BRIEFING_LAT: '40,4168',
        PA_BRIEFING_LON: '-3,7038',
        PA_BRIEFING_PLACE: 'Madrid',
      }),
    ).toBe('resumen         cada mañana a las 7:00, con el tiempo de Madrid');
    expect(briefingDoctorLine({ PA_BRIEFING: '1' })).toBe(
      'resumen         cada mañana a las 8:00, sin el tiempo (pon PA_BRIEFING_LAT y PA_BRIEFING_LON para verlo)',
    );
  });

  it('hora o coordenadas que no valen: lo dice y usa lo de por defecto', () => {
    const line = briefingDoctorLine({ PA_BRIEFING: '1', PA_BRIEFING_HOUR: '25' });
    expect(line).toContain('cada mañana a las 8:00 (PA_BRIEFING_HOUR «25» no vale');
    expect(
      briefingDoctorLine({ PA_BRIEFING: '1', PA_BRIEFING_LAT: 'Madrid', PA_BRIEFING_LON: '' }),
    ).toContain('sin el tiempo: PA_BRIEFING_LAT o PA_BRIEFING_LON no valen');
  });

  it('cli.ts lo añade a pa doctor', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(src).toContain('lines.push(briefingDoctorLine());');
  });
});
