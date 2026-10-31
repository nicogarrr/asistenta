/**
 * Primer uso: «PA_BRIEFING=sí» o «true» en el .env no encendía el resumen de la
 * mañana (solo valía «1»), y PA_BRIEFING_HOUR=24 lo dejaba sin salir nunca.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { briefingHour, envOn } from '../src/briefing-env.js';

describe('resumen de la mañana: valores del .env como los escribe una persona', () => {
  it('sí, si, true, yes, on y 1 lo encienden', () => {
    for (const v of ['1', 'sí', 'si', 'SÍ', 'Si ', 'true', 'TRUE', 'yes', 'on', 'activado']) {
      expect(envOn(v), v).toBe(true);
    }
  });

  it('lo demás lo deja apagado', () => {
    for (const v of [undefined, '', '0', 'no', 'false', 'off', 'quizá', '2']) {
      expect(envOn(v), String(v)).toBe(false);
    }
  });

  it('la hora: 0 a 23, también «08» u «8:30»; lo que no vale usa la de por defecto', () => {
    expect(briefingHour('8')).toBe(8);
    expect(briefingHour('08')).toBe(8);
    expect(briefingHour('8:30')).toBe(8);
    expect(briefingHour('7h')).toBe(7);
    expect(briefingHour('0')).toBe(0);
    expect(briefingHour('23')).toBe(23);
    for (const v of ['24', '25', '99', '-1', 'ocho', '', undefined, '8 de la mañana']) {
      expect(briefingHour(v), String(v)).toBeUndefined();
    }
  });

  it('cli.ts usa estas lecturas para PA_BRIEFING, PA_BRIEFING_HOUR y PA_BRIEFING_VOZ', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(src).toContain('enabled: () => envOn(process.env.PA_BRIEFING),');
    expect(src).toContain('hour: briefingHour(process.env.PA_BRIEFING_HOUR),');
    expect(src).toContain('envOn(process.env.PA_BRIEFING_VOZ) && desktop');
    expect(src).not.toContain("process.env.PA_BRIEFING === '1'");
  });
});
