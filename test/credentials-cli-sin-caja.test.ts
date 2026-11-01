import { describe, expect, it } from 'vitest';
import { CUENTAS_GESTOR_KO, cuentasCommand } from '../src/credentials/export.js';
import type { VaultOps } from '../src/credentials/store.js';

const RAW = 'No hay caja fuerte de claves en C:\\Users\\nico\\AppData\\pa\\vault.json';
const noVault: VaultOps = {
  get: async () => {
    throw new Error(RAW);
  },
  set: async () => {
    throw new Error(RAW);
  },
  delete: async () => {
    throw new Error(RAW);
  },
  list: async () => {
    throw new Error(RAW);
  },
};

async function run(argv: string[], exists: boolean) {
  const lines: string[] = [];
  const code = await cuentasCommand(argv, {
    vault: noVault,
    out: (s) => lines.push(s),
    vaultExists: () => exists,
    isTty: true,
    ask: async () => '',
  });
  return { code, text: lines.join('\n') };
}

describe('pa cuentas en una instalación nueva, sin caja fuerte', () => {
  it('«pa cuentas» dice en una línea llana que aún no hay caja fuerte, sin error', async () => {
    for (const argv of [[], ['listar'], ['lista']]) {
      const { code, text } = await run(argv, false);
      expect(code).toBe(0);
      expect(text.split('\n')).toHaveLength(1);
      expect(text).toMatch(/Todavía no tienes caja fuerte de claves/);
      expect(text).toContain('instalar.bat');
      expect(text).not.toContain(CUENTAS_GESTOR_KO);
      expect(text).not.toMatch(/AppData|vault\.json|Error|Prueba otra vez/);
    }
  });

  it('copiar sin caja fuerte: la misma línea y sale con fallo', async () => {
    const { code, text } = await run(['copiar', 'wallapop.es'], false);
    expect(code).toBe(1);
    expect(text).toMatch(/Todavía no tienes caja fuerte/);
  });

  it('con caja fuerte que no se puede leer sigue el aviso de siempre', async () => {
    const { code, text } = await run(['listar'], true);
    expect(code).toBe(1);
    expect(text).toBe(CUENTAS_GESTOR_KO);
  });
});
