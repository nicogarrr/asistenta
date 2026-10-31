/**
 * Primer uso en Windows: PA_TIMEZONE mal escrita en el .env («Madrid», «GMT+1»)
 * solo dejaba una línea en inglés en la consola y los recordatorios usaban la
 * hora del PC sin avisar. Ahora lo dicen `pa doctor` y un aviso por Telegram.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootProblemText } from '../src/boot-notice.js';
import { invalidTimeZone, timeZoneDoctorLine } from '../src/timezone-doctor.js';

describe('PA_TIMEZONE mal puesta', () => {
  it('detecta zonas que no valen y acepta las buenas', () => {
    expect(invalidTimeZone({ PA_TIMEZONE: 'Madrid' })).toBe('Madrid');
    expect(invalidTimeZone({ PA_TIMEZONE: ' GMT+1 ' })).toBe('GMT+1');
    expect(invalidTimeZone({ PA_TIMEZONE: 'Europe/Madrid' })).toBeNull();
    expect(invalidTimeZone({ PA_TIMEZONE: 'Atlantic/Canary' })).toBeNull();
    expect(invalidTimeZone({ PA_TIMEZONE: '  ' })).toBeNull();
    expect(invalidTimeZone({})).toBeNull();
  });

  it('pa doctor lo dice en castellano con un ejemplo', () => {
    const bad = timeZoneDoctorLine({ PA_TIMEZONE: 'Madrid' });
    expect(bad).toMatch(/^zona horaria +PA_TIMEZONE «Madrid» no vale/);
    expect(bad).toContain('Europe/Madrid');
    expect(timeZoneDoctorLine({ PA_TIMEZONE: 'Europe/Madrid' })).toBe(
      'zona horaria    Europe/Madrid',
    );
    expect(timeZoneDoctorLine({ PA_TIMEZONE: 'x<script>\n'.repeat(9) })).not.toMatch(/[<>\n]/);
  });

  it('aviso de arranque por Telegram, en castellano llano', () => {
    const text = bootProblemText(['zona-horaria']);
    expect(text).toContain('PA_TIMEZONE=Europe/Madrid');
    expect(text).toContain('reinicia Asistenta');
    expect(text).not.toMatch(/undefined|Error|time zone/);
  });

  it('cli.ts lo conecta al doctor y al aviso de arranque', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    expect(src).toContain('lines.push(timeZoneDoctorLine());');
    expect(src).toContain("[...panel.problems, 'zona-horaria' as const]");
  });
});
