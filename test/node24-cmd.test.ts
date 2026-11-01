import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Los .bat de Windows buscan Node 24 en cualquier PC, no en la carpeta de Nico. */
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const bats = ['instalar.bat', 'levantar.bat'];

describe('scripts/node24.cmd: buscar Node 24 en cualquier PC', () => {
  it('ningun .bat lleva una ruta de usuario fija', () => {
    for (const b of bats) {
      expect(read(b)).not.toMatch(/C:\\Users\\/i);
      expect(read(b)).not.toContain('nicoi');
    }
  });

  it('los dos .bat usan el mismo buscador y avisan en castellano si no hay Node 24', () => {
    for (const b of bats) {
      const bat = read(b);
      expect(bat).toContain('call scripts\\node24.cmd');
      const miss = bat.slice(bat.indexOf('if not defined NODE_EXE'));
      expect(bat.indexOf('if not defined NODE_EXE')).toBeGreaterThan(bat.indexOf('node24.cmd'));
      expect(miss).toMatch(/No encuentro Node 24/);
      expect(miss).toContain('https://nodejs.org');
      expect(miss).toMatch(/pause\r?\n\s*exit \/b 1/);
    }
  });

  it('prueba el PATH y las carpetas habituales, exige 24+ y pone su carpeta en el PATH (npm)', () => {
    expect(existsSync(new URL('../scripts/node24.cmd', import.meta.url))).toBe(true);
    const cmd = read('scripts/node24.cmd');
    const order = [
      '"%ASISTENTA_NODE%"',
      '"node"',
      '"%ProgramFiles%\\nodejs\\node.exe"',
      '"%LOCALAPPDATA%\\Programs\\nodejs\\node.exe"',
      '"%NVM_SYMLINK%\\node.exe"',
      '"%USERPROFILE%\\.local\\node24\\node.exe"',
    ].map((s) => cmd.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(cmd).toContain('>=24');
    expect(cmd).toMatch(/set "PATH=%~dp1;%PATH%"/);
  });

  it('es ASCII y CRLF, como los .bat', () => {
    for (const f of [...bats, 'scripts/node24.cmd']) {
      const t = read(f);
      expect([...t].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
      expect(
        t
          .split('\n')
          .slice(0, -1)
          .every((l) => l.endsWith('\r')),
      ).toBe(true);
    }
  });
});
