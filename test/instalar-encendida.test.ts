import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { instalar } from '../scripts/instalar.mjs';

// Volver a abrir instalar.bat con Asistenta encendida: npm ci borra node_modules y
// Windows no deja tocar los archivos abiertos, así que fallaba a mitad con EBUSY.
// Ahora lo detecta antes y ofrece apagarla.
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

describe('instalar.bat con Asistenta encendida', () => {
  it('si dices que no, no toca nada y explica cómo apagarla', async () => {
    const { d, text } = deps({ encendida: vi.fn(async () => true), ask: vi.fn(async () => 'n') });
    expect(await instalar(d)).toBe(1);
    expect(d.run).not.toHaveBeenCalled();
    expect(d.cli).not.toHaveBeenCalled();
    expect(text()).toContain('Asistenta sigue encendida');
    expect(text()).toContain('levantar.bat');
  });

  it('si dices que sí, la apaga antes de npm ci y sigue', async () => {
    const orden: string[] = [];
    const cli = vi.fn(async (a: string[]) => {
      orden.push(`cli ${a.join(' ')}`);
      return a[0] === 'stop' ? 0 : 1;
    });
    const run = vi.fn(async (_c: string, a: string[]) => {
      orden.push(`npm ${a[0]}`);
      return 0;
    });
    const ask = vi.fn(async (q: string) => (q.includes('¿La apago') ? 's' : ''));
    const { d, text } = deps({ encendida: vi.fn(async () => true), cli, run, ask });
    await instalar(d);
    expect(orden.slice(0, 2)).toEqual(['cli stop', 'npm ci']);
    expect(text()).toContain('✓ Asistenta apagada');
  });

  it('si la parada falla pero ya no está encendida (pid viejo), sigue', async () => {
    const encendida = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { d, text } = deps({ encendida, ask: vi.fn(async () => 's') });
    await instalar(d);
    expect(d.run).toHaveBeenCalled();
    expect(text()).not.toContain('Asistenta sigue encendida');
  });

  it('si la parada falla y sigue encendida, para sin instalar', async () => {
    const { d, text } = deps({ encendida: vi.fn(async () => true), ask: vi.fn(async () => 's') });
    expect(await instalar(d)).toBe(1);
    expect(d.run).not.toHaveBeenCalled();
    expect(text()).toContain('Asistenta sigue encendida');
  });

  it('apagada: ni pregunta', async () => {
    const { d } = deps({ encendida: vi.fn(async () => false) });
    await instalar(d);
    expect(d.ask).not.toHaveBeenCalledWith(expect.stringContaining('¿La apago'));
    expect(d.run).toHaveBeenCalled();
  });
});
