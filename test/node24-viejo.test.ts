import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Con un Node viejo (p. ej. 20) en el PC, los .bat decían «No encuentro Node 24» y la
 * persona respondía «pero si lo tengo». Ahora dicen qué versión tiene y que hace falta la 24.
 */
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('Node demasiado viejo en los .bat', () => {
  it('node24.cmd apunta la versión del primer Node viejo que encuentra en NODE_OLD', () => {
    const cmd = read('scripts/node24.cmd');
    expect(cmd).toMatch(/set "NODE_OLD="/);
    const viejo = cmd.slice(cmd.indexOf(':viejo'));
    expect(cmd).toMatch(/if errorlevel 1 goto :viejo/);
    expect(viejo).toMatch(/if defined NODE_OLD exit \/b 0/);
    expect(viejo).toMatch(/"%~1" -v >"%TEMP%\\asistenta-node-v\.txt" 2>nul/);
    expect(viejo).toMatch(/set \/p NODE_OLD=<"%TEMP%\\asistenta-node-v\.txt"/);
    expect(viejo).toMatch(/del "%TEMP%\\asistenta-node-v\.txt"/);
  });

  for (const [bat, tag] of [
    ['instalar.bat', 'instalar'],
    ['levantar.bat', 'levantar'],
  ] as const) {
    it(`${bat}: con Node viejo dice la versión y que hace falta la 24`, () => {
      const t = read(bat);
      const miss = t.slice(t.indexOf('if not defined NODE_EXE ('));
      const old = miss.slice(miss.indexOf('if defined NODE_OLD ('));
      expect(miss.indexOf('if defined NODE_OLD (')).toBeGreaterThan(0);
      expect(miss.indexOf('if defined NODE_OLD (')).toBeLessThan(
        miss.indexOf('No encuentro Node 24'),
      );
      expect(old).toContain(
        `[${tag}] Tienes Node %NODE_OLD%, pero Asistenta necesita la version 24`,
      );
      expect(old).toContain('https://nodejs.org');
      expect(old).toMatch(/pause\r?\n\s*exit \/b 1/);
    });
  }
});
