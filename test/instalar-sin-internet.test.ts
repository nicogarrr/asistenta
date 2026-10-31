import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { instalar } from '../scripts/instalar.mjs';

// Dos fallos de primera vez que el instalador explicaba mal:
// - Node sin npm (un node.exe suelto): «npm ci» fallaba y el mensaje hablaba de internet.
// - Sin internet: «npm ci» borra node_modules antes de descargar, así que repetir la
//   instalación sin conexión rompía una instalación que funcionaba. Ahora pregunta antes.
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
    npm: vi.fn(async () => true),
    internet: vi.fn(async () => true),
    ...over,
  };
  return { d, text: () => out.join('') };
}

const npmCi = (run: ReturnType<typeof vi.fn>) =>
  run.mock.calls.some((c) => c[0] === 'npm' && (c[1] as string[])[0] === 'ci');

describe('instalar: npm y conexión antes de npm ci', () => {
  it('sin npm lo dice claro (no habla de internet) y no ejecuta npm ci', async () => {
    const { d, text } = deps({ npm: vi.fn(async () => false) });
    expect(await instalar(d)).toBe(1);
    expect(npmCi(d.run)).toBe(false);
    expect(text()).toContain('No encuentro npm');
    expect(text()).toContain('nodejs.org');
    expect(text()).not.toContain('internet');
  });

  it('sin internet pregunta antes de npm ci; con «n» para sin tocar node_modules', async () => {
    const ask = vi.fn(async (_q: string) => 'n');
    const { d, text } = deps({ internet: vi.fn(async () => false), ask });
    expect(await instalar(d)).toBe(1);
    expect(npmCi(d.run)).toBe(false);
    expect(text()).toContain('No llego a internet');
    expect(text()).toContain('Conéctate a internet');
    expect(ask.mock.calls[0]?.[0]).toContain('¿Pruebo igualmente?');
  });

  it('sin internet, con node_modules avisa de que npm ci la borraría', async () => {
    const { d, text } = deps({
      internet: vi.fn(async () => false),
      exists: (p: string) => p === 'node_modules',
      ask: vi.fn(async () => 'n'),
    });
    expect(await instalar(d)).toBe(1);
    expect(text()).toContain('node_modules');
  });

  it('sin internet y «s» prueba igualmente', async () => {
    const ask = vi.fn(async (q: string) => (q.includes('¿Pruebo') ? 's' : ''));
    const { d } = deps({ internet: vi.fn(async () => false), ask });
    await instalar(d);
    expect(npmCi(d.run)).toBe(true);
  });

  it('con internet y npm no pregunta nada antes de npm ci', async () => {
    const { d } = deps();
    await instalar(d);
    expect(npmCi(d.run)).toBe(true);
    expect(d.ask).not.toHaveBeenCalledWith(expect.stringContaining('¿Pruebo'), expect.anything());
  });
});
