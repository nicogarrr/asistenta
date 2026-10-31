import { describe, expect, it } from 'vitest';
import { setupCommand } from '../src/setup.js';

// Primer uso: `pa setup --check` (o cualquier opción) contestaba con la línea
// técnica «uso: pa setup (terminal local, sin argumentos secretos)».
async function correr(args: string[], platform: NodeJS.Platform) {
  let out = '';
  const code = await setupCommand(args, {
    platform,
    write: (s) => {
      out += s;
    },
    question: async () => {
      throw new Error('no debe preguntar');
    },
  });
  return { code, out };
}

describe('pa setup con opciones', () => {
  it('en Linux dice en castellano llano qué hacer y apunta a pa doctor', async () => {
    const { code, out } = await correr(['--check'], 'linux');
    expect(code).toBe(2);
    expect(out).not.toMatch(/^uso:/);
    expect(out).toContain('«pa setup» no lleva opciones');
    expect(out).toContain('escribe solo «pa setup»');
    expect(out).toContain('«pa doctor»');
  });

  it('en Windows apunta a instalar.bat', async () => {
    const { code, out } = await correr(['--check'], 'win32');
    expect(code).toBe(2);
    expect(out).toContain('instalar.bat');
    expect(out).toContain('«pa doctor»');
    expect(out).not.toContain('uso:');
  });

  it('nunca repite lo escrito (podría ser una clave)', async () => {
    const { out } = await correr(['sk-SECRETO-123'], 'linux');
    expect(out).not.toContain('SECRETO');
  });
});
