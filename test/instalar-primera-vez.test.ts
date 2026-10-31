import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { instalar } from '../scripts/instalar.mjs';

// Tropiezos de la primera instalación en un Windows nuevo: compilar con el antivirus
// bloqueando archivos, no tener git y el aviso de SmartScreen al abrir instalar.bat.
function deps(over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const d = {
    nodeVersion: 'v24.3.0',
    cwd: 'C:\\Asistenta',
    env: {},
    write: (s: string) => out.push(s),
    run: vi.fn(async () => 0),
    exists: () => false,
    copy: vi.fn(),
    readEnv: () => '',
    cli: vi.fn(async () => 1),
    vaultList: async () => null,
    vaultSet: vi.fn(async () => 0),
    ask: vi.fn(async () => ''),
    fetch: vi.fn(),
    ...over,
  };
  return { d, text: () => out.join('') };
}

describe('primera instalación en Windows', () => {
  it('si la compilación falla, explica EPERM/EBUSY (antivirus u otra ventana) antes de mandar a descargar', async () => {
    const run = vi.fn(async (_c: string, a: string[]) => (a[0] === 'run' ? 1 : 0));
    const { d, text } = deps({ run });
    expect(await instalar(d)).toBe(1);
    expect(text()).toContain('EPERM o EBUSY');
    expect(text()).toContain('el antivirus');
    expect(text().indexOf('EPERM')).toBeLessThan(text().indexOf('descarga Asistenta otra vez'));
  });

  it('el README dice qué hacer sin git y con el aviso de SmartScreen', () => {
    const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');
    expect(readme).toContain('https://git-scm.com');
    expect(readme).toContain('«Ejecutar de todas formas»');
  });
});
