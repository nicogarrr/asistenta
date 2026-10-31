import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { instalar } from '../scripts/instalar.mjs';

/** Quien abre el .bat desde dentro del ZIP (Windows solo copia ese archivo a una carpeta temporal). */
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('abrir los .bat sin descomprimir el ZIP', () => {
  for (const [bat, tag] of [
    ['instalar.bat', 'instalar'],
    ['levantar.bat', 'levantar'],
  ] as const) {
    it(`${bat}: si no ve los archivos de Asistenta, pide descomprimir antes de nada`, () => {
      const t = read(bat);
      const check = t.indexOf('if not exist package.json (');
      expect(check).toBeGreaterThan(t.indexOf('cd /d "%~dp0"'));
      expect(check).toBeLessThan(t.indexOf('call scripts\\node24.cmd'));
      const block = t.slice(check, t.indexOf('exit /b 1', check));
      expect(block).toContain(`[${tag}]`);
      expect(block).toMatch(/descompr/i);
      expect(block).toContain('Extraer todo');
      expect(block).toContain('pause');
    });
  }

  it('si falla la compilación no da por hecho que usas git', async () => {
    const out: string[] = [];
    let n = 0;
    const code = await instalar({
      nodeVersion: 'v24.3.0',
      write: (s: string) => out.push(s),
      run: async () => (n++ === 0 ? 0 : 1),
    });
    expect(code).toBe(1);
    const text = out.join('');
    expect(text).toContain('No se ha podido compilar');
    expect(text).toMatch(/descarga/i);
    expect(text).not.toMatch(/Actualiza la carpeta del proyecto \(git pull\)/);
  });
});
