import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** levantar.bat: el doble clic de Nico en Windows. */
const bat = readFileSync(new URL('../levantar.bat', import.meta.url), 'utf8');

describe('levantar.bat', () => {
  it('arranca con pa iniciar (comprobación verde/rojo y luego el daemon), no con serve a pelo', () => {
    expect(bat).toMatch(/dist\\cli\.js iniciar\r?\n/);
    expect(bat).not.toMatch(/dist\\cli\.js serve/);
  });

  it('pone la consola en UTF-8 antes de pintar la lista', () => {
    const chcp = bat.indexOf('chcp 65001');
    expect(chcp).toBeGreaterThan(0);
    expect(chcp).toBeLessThan(bat.indexOf('dist\\cli.js iniciar'));
  });

  it('sigue comprobando Node 24 y dist antes, y deja la ventana abierta si falla', () => {
    expect(bat).toContain('>=24');
    expect(bat).toContain('if not exist dist\\cli.js');
    expect(bat.slice(bat.indexOf('cli.js iniciar'))).toMatch(/if errorlevel 1 \(\r?\n[\s\S]*pause/);
  });

  it('es ASCII (cmd.exe lee el .bat antes del chcp) y mantiene los CRLF', () => {
    expect([...bat].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
    expect(
      bat
        .split('\n')
        .slice(0, -1)
        .every((line) => line.endsWith('\r')),
    ).toBe(true);
  });
});
