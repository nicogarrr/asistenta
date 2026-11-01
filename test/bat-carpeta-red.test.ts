import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// instalar.bat / levantar.bat abiertos desde una carpeta de red (\\servidor\carpeta):
// cmd no puede usar una ruta UNC como carpeta actual, `cd /d` falla y se queda en
// C:\Windows, y el .bat decía «lo has abierto desde el ZIP». Ahora lo dice claro
// antes de intentar entrar.
for (const bat of ['instalar.bat', 'levantar.bat']) {
  describe(`${bat} en una carpeta de red`, () => {
    const text = readFileSync(bat, 'utf8');
    it('lo detecta antes de cd /d y pide copiarla al PC', () => {
      const unc = text.indexOf('if "%~d0"=="\\\\" (');
      const cd = text.indexOf('cd /d "%~dp0"');
      expect(unc).toBeGreaterThan(0);
      expect(cd).toBeGreaterThan(unc);
      const bloque = text.slice(unc, cd);
      expect(bloque).toContain('carpeta de red');
      expect(bloque).toContain('C:\\Asistenta');
      expect(bloque).toContain('exit /b 1');
    });
    it('el aviso no mete la ruta dentro del bloque (un «)» lo rompería)', () => {
      const unc = text.indexOf('if "%~d0"=="\\\\" (');
      const bloque = text.slice(unc, text.indexOf('cd /d "%~dp0"'));
      expect(bloque).not.toMatch(/%~[a-z]*p[a-z]*0/);
    });
  });
}
