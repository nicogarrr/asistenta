import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localDay } from '../src/datecontext.js';

// «Hoy» es el día de Madrid, no el día UTC: entre las 00:00 y la 01:00 (02:00 en
// verano) `toISOString().slice(0, 10)` devolvía el día anterior en 17 sitios
// (fechas de memoria y skills, presupuesto diario, tope de peticiones por tienda…).
describe('localDay', () => {
  let tz: string | undefined;
  beforeEach(() => {
    tz = process.env.TZ;
    process.env.TZ = 'Europe/Madrid';
  });
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it('pasada la medianoche de Madrid ya es el día nuevo (invierno, UTC+1)', () => {
    const at = new Date('2026-10-30T23:30:00Z'); // 00:30 del 31 en Madrid
    expect(at.toISOString().slice(0, 10)).toBe('2026-10-30');
    expect(localDay(at)).toBe('2026-10-31');
  });

  it('en verano (UTC+2) también, y acepta milisegundos', () => {
    const ms = Date.parse('2026-07-14T22:15:00Z'); // 00:15 del 15 en Madrid
    expect(localDay(ms)).toBe('2026-07-15');
  });

  it('el día del cambio de hora (25 oct 2026) no salta ni repite días', () => {
    expect(localDay(new Date('2026-10-24T22:30:00Z'))).toBe('2026-10-25');
    expect(localDay(new Date('2026-10-25T22:59:00Z'))).toBe('2026-10-25');
    expect(localDay(new Date('2026-10-25T23:00:00Z'))).toBe('2026-10-26');
  });
});

describe('ningún «hoy» en UTC dentro de src/', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return files(p);
      return p.endsWith('.ts') ? [p] : [];
    });
  }

  it('no queda `toISOString().slice(0, 10)` en código (usa localDay)', () => {
    const offenders: string[] = [];
    for (const file of files('src')) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith('*') || code.startsWith('//')) return;
          if (/toISOString\(\)\.slice\(0,\s*10\)/.test(code)) offenders.push(`${file}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
