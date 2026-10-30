// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que runner.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { describe, expect, it } from 'vitest';

/** The guest process that runs factory tool code has a heap ceiling. */
void FACTORY_TEST_STATE_DIR;
const store = await import('../src/factory/store.js');
const runner = await import('../src/factory/runner.js');

function install(id: string, body: string): void {
  const code = `export const name='t'; export const description='d'; export const parameters={type:'object'};\n${body}`;
  const now = new Date().toISOString();
  store.writeFactoryTool(
    {
      id,
      name: id,
      description: 'd',
      whenToUse: 'w',
      version: 1,
      status: 'built',
      createdAt: now,
      updatedAt: now,
      codeSha256: store.sha256(code),
      testedSha256: null,
      lastTestAt: null,
      lastTestOk: false,
      contract: null,
    },
    code,
    '',
  );
}

describe('factory runner: tope de memoria del guest', () => {
  it('una herramienta que reserva memoria sin fin muere sola y no da ok', async () => {
    // ~480 MB of live arrays: over the guest ceiling, well under the box.
    install(
      'mem-hog',
      'export async function run(){ const a = []; for (let i = 0; i < 60; i++) a.push(new Array(1e6).fill(i)); return String(a.length); }',
    );
    const r = await runner.runFactoryToolSandboxed('mem-hog', {}, { timeoutMs: 30_000 });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('supervisor');
  }, 60_000);

  it('una herramienta normal con algo de memoria sigue funcionando', async () => {
    install(
      'mem-ok',
      'export async function run(){ const a = new Array(1e6).fill(1); return String(a.length); }',
    );
    const r = await runner.runFactoryToolSandboxed('mem-ok', {}, { timeoutMs: 30_000 });
    expect(r.ok).toBe(true);
    expect(r.output).toBe('1000000');
  }, 60_000);

  it('el tope es un número razonable de MB', () => {
    expect(runner.GUEST_HEAP_MB).toBeGreaterThanOrEqual(128);
    expect(runner.GUEST_HEAP_MB).toBeLessThanOrEqual(1024);
  });
});
