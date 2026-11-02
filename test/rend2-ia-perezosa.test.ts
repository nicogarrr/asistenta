import { describe, expect, it, vi } from 'vitest';

// pi-ai y pi-agent-core (~90 ms y ~20 MB) solo hacen falta al crear el proveedor del
// modelo o un agente. Las órdenes `pa …` que no hablan con el modelo (ayuda, vault,
// stop, estado…) cargaban todo cli.ts y con él estos paquetes; ahora no.
const cargados = vi.hoisted(() => [] as string[]);
vi.mock('@earendil-works/pi-ai', async (orig) => {
  cargados.push('pi-ai');
  return orig();
});
vi.mock('@earendil-works/pi-ai/models', async (orig) => {
  cargados.push('pi-ai/models');
  return orig();
});
vi.mock('@earendil-works/pi-ai/api/openai-completions.lazy', async (orig) => {
  cargados.push('pi-ai/openai-completions');
  return orig();
});
vi.mock('@earendil-works/pi-agent-core', async (orig) => {
  cargados.push('pi-agent-core');
  return orig();
});

describe('carga perezosa del modelo', () => {
  it('importar cli.ts, el agente y el proveedor no carga pi-ai ni pi-agent-core', async () => {
    await import('../src/core/provider.js');
    await import('../src/core/agent.js');
    await import('../src/cli.js');
    expect(cargados).toEqual([]);
  }, 60_000);

  it('crear el proveedor sí carga pi-ai (y sigue funcionando)', async () => {
    const { createProviderHandle } = await import('../src/core/provider.js');
    process.env.PA_API_KEY = 'clave-de-prueba';
    const handle = await createProviderHandle({
      provider: 'opencode',
      model: 'modelo-de-prueba',
      baseUrl: 'http://127.0.0.1:1/v1',
      contextWindowTokens: 100_000,
      maxOutputTokens: 1_000,
    } as never);
    expect(handle.model.id).toBe('modelo-de-prueba');
    expect(typeof handle.streamFn).toBe('function');
    expect(cargados).toContain('pi-ai');
  });
});
