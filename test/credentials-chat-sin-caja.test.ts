import { describe, expect, it } from 'vitest';
import type { VaultOps } from '../src/credentials/store.js';
import {
  createAccountsTool,
  SIGNUP_VAULT_FAILED,
  VAULT_UNREADABLE,
} from '../src/tools/accounts.js';

const RAW = 'No hay caja fuerte de claves en C:\\Users\\nico\\AppData\\pa\\vault.json';
const fail = async (): Promise<never> => {
  throw new Error(RAW);
};
const noVault: VaultOps = { get: fail, set: fail, delete: fail, list: fail };
const ME = { name: 'Nico', email: 'nico@example.com' };

async function ask(args: Record<string, unknown>, exists: boolean): Promise<string> {
  const tool = createAccountsTool(
    noVault,
    async () => ME,
    undefined,
    () => exists,
  );
  const r = await tool.execute('t', args as never);
  return (r.content[0] as { text: string }).text;
}

describe('cuentas en el chat, en una instalación nueva sin caja fuerte', () => {
  it('«¿qué cuentas tengo?» responde llano: aún no hay caja fuerte, sin «prueba otra vez»', async () => {
    for (const args of [{ action: 'listar' }, { action: 'buscar', sitio: 'wallapop' }]) {
      const t = await ask(args, false);
      expect(t).toMatch(/Todavía no tengo ninguna cuenta guardada/);
      expect(t).toMatch(/caja fuerte/);
      expect(t).not.toBe(VAULT_UNREADABLE);
      expect(t).not.toMatch(/AppData|vault\.json|Prueba otra vez/);
    }
  });

  it('«regístrame en wallapop.es» sin caja fuerte dice cómo crearla, sin tocar la web', async () => {
    const t = await ask({ action: 'preparar_registro', sitio: 'wallapop.es' }, false);
    expect(t).toMatch(/no tienes caja fuerte/);
    expect(t).toContain('no he tocado nada en la web');
    expect(t).not.toBe(SIGNUP_VAULT_FAILED);
    expect(t).not.toMatch(/AppData|vault\.json/);
  });

  it('con caja fuerte que falla, el aviso de siempre', async () => {
    expect(await ask({ action: 'listar' }, true)).toBe(VAULT_UNREADABLE);
    expect(await ask({ action: 'preparar_registro', sitio: 'wallapop.es' }, true)).toBe(
      SIGNUP_VAULT_FAILED,
    );
  });
});
