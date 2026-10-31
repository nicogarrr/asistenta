import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error TS7016: módulo .mjs ejecutable, sin declaración de tipos.
import { instalar, ordenPa } from '../scripts/instalar.mjs';

// Si Node no está en el PATH (lo encontró scripts\node24.cmd en otra carpeta o en
// ASISTENTA_NODE), «node dist\cli.js stop» no se reconoce en una ventana nueva.
// El aviso da entonces la orden con la ruta completa de node.exe.
const NODE = 'C:\\Users\\Ana\\node24\\node.exe';

function deps(over: Record<string, unknown> = {}) {
  const out: string[] = [];
  const d = {
    nodeVersion: 'v24.3.0',
    cwd: 'C:\\Asistenta',
    env: {},
    execPath: NODE,
    write: (s: string) => out.push(s),
    run: vi.fn(async () => 0),
    exists: () => false,
    copy: vi.fn(),
    readEnv: () => '',
    cli: vi.fn(async () => 1),
    vaultList: async () => null,
    vaultSet: vi.fn(async () => 0),
    ask: vi.fn(async () => 'n'),
    encendida: vi.fn(async () => true),
    fetch: vi.fn(),
    ...over,
  };
  return { d, text: () => out.join('') };
}

describe('orden para apagar Asistenta cuando Node no está en el PATH', () => {
  it('con Node fuera del PATH, el aviso lleva la ruta completa de node.exe', async () => {
    const { d, text } = deps({ env: { ASISTENTA_NODE_FUERA_PATH: '1' } });
    expect(await instalar(d)).toBe(1);
    expect(text()).toContain(`"${NODE}" dist\\cli.js stop`);
    expect(text()).not.toMatch(/[ (]node dist\\cli\.js stop/);
  });

  it('con Node en el PATH sigue diciendo «node dist\\cli.js stop»', async () => {
    const { d, text } = deps();
    expect(await instalar(d)).toBe(1);
    expect(text()).toContain('node dist\\cli.js stop');
    expect(text()).not.toContain(NODE);
  });

  it('ordenPa: sin ruta de node conocida, «node» a secas', () => {
    expect(ordenPa('stop', { ASISTENTA_NODE_FUERA_PATH: '1' }, undefined)).toBe(
      'node dist\\cli.js stop',
    );
    expect(ordenPa('stop', { ASISTENTA_NODE_FUERA_PATH: '1' }, NODE)).toBe(
      `"${NODE}" dist\\cli.js stop`,
    );
  });

  it('scripts\\node24.cmd marca cuando usa un Node que no está en el PATH', () => {
    const cmd = readFileSync('scripts/node24.cmd', 'utf8');
    expect(cmd).toMatch(/set "ASISTENTA_NODE_FUERA_PATH="/);
    expect(cmd).toMatch(/if \/i not "%~1"=="node" set "ASISTENTA_NODE_FUERA_PATH=1"/);
  });
});
