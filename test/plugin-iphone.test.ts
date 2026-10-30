import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { iphonePlugin, iphoneToolDeps } from '../src/plugins/iphone.js';

vi.mock('../src/vault.js', () => ({ vaultGet: async () => undefined }));

describe('el iPhone como plugin (solo cableado)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('aporta una sola tool `iphone` y no toca el teléfono al construirla', () => {
    const tools = iphonePlugin.tools({});
    expect(iphonePlugin.id).toBe('iphone');
    expect(tools.map((t) => t.name)).toEqual(['iphone']);
  });

  it('sin URL configurada, cada acción falla con el mismo mensaje legible de antes', async () => {
    vi.stubEnv('PA_IPHONE_URL', '');
    await expect(iphoneToolDeps().status()).rejects.toThrow(/iphone:url\) o PA_IPHONE_URL/);
  });

  it('cli.ts ya no lleva el cableado del iPhone: lo pide al plugin', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).not.toMatch(/function iphoneToolDeps\(/);
    expect(cli).not.toMatch(/new IphoneClient\(/);
    expect(cli).toMatch(/iphonePlugin\.tools\(\{\}\)/);
  });
});
