import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { instalar, realDeps } from '../scripts/instalar.mjs';

// Un usuario sin permisos que hace «Ejecutar como administrador» acaba con la consola
// de OTRA cuenta: la caja fuerte se guarda en ese perfil y levantar.bat no la ve.
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

describe('instalar.bat abierto como administrador', () => {
  it('avisa y, si no confirmas, para antes de tocar nada', async () => {
    const { d, text } = deps({ elevado: vi.fn(async () => true) });
    expect(await instalar(d)).toBe(1);
    expect(d.run).not.toHaveBeenCalled();
    expect(text()).toContain('como administrador');
    expect(text()).toContain('doble clic normal');
  });

  it('si confirmas, sigue con la instalación', async () => {
    const ask = vi.fn(async (q: string) => (q.includes('¿Sigo') ? 's' : ''));
    const { d } = deps({ elevado: vi.fn(async () => true), ask });
    await instalar(d);
    expect(d.run).toHaveBeenCalledWith('npm', ['ci', '--no-audit', '--no-fund']);
  });

  it('con tu usuario normal ni pregunta', async () => {
    const { d, text } = deps({ elevado: vi.fn(async () => false) });
    await instalar(d);
    expect(d.ask).not.toHaveBeenCalledWith(expect.stringContaining('¿Sigo'));
    expect(text()).not.toContain('como administrador.');
  });

  it('las dependencias reales saben comprobarlo (y fuera de Windows dicen que no)', async () => {
    expect(typeof realDeps.elevado).toBe('function');
    if (process.platform !== 'win32') expect(await realDeps.elevado()).toBe(false);
  });
});
