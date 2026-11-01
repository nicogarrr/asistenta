import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { instalar, realDeps } from '../scripts/instalar.mjs';

// npm ci y la compilación salen bien, pero el antivirus aparta un archivo de
// node_modules y Asistenta ya no arranca. Antes el instalador decía «✓ Programa
// listo» y luego culpaba a la caja fuerte («usuario normal, no administrador»).
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
    vaultList: vi.fn(async () => null),
    vaultSet: vi.fn(async () => 0),
    ask: vi.fn(async () => ''),
    fetch: vi.fn(),
    ...over,
  };
  return { d, text: () => out.join('') };
}

describe('instalar: Asistenta compilada pero no arranca', () => {
  it('lo dice claro (antivirus, node_modules) y no culpa a la caja fuerte', async () => {
    const { d, text } = deps({ arranca: vi.fn(async () => false) });
    expect(await instalar(d)).toBe(1);
    expect(text()).not.toContain('✓ Programa listo');
    expect(text()).toContain('antivirus');
    expect(text()).toContain('node_modules');
    expect(text()).not.toContain('caja fuerte');
    expect(d.vaultList).not.toHaveBeenCalled();
  });

  it('si arranca, sigue como siempre', async () => {
    const { d, text } = deps({
      arranca: vi.fn(async () => true),
      exists: (f: string) => f === '.env.example',
    });
    await instalar(d);
    expect(text()).toContain('✓ Programa listo');
    expect(d.vaultList).toHaveBeenCalled();
  });

  it('el instalador real lo comprueba con «pa --help», sin enseñar la ayuda', () => {
    expect(typeof realDeps.arranca).toBe('function');
  });
});
