// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que runner.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { describe, expect, it } from 'vitest';

/**
 * A tool that never finishes loading (a top-level await that never settles, or
 * a synchronous loop while the module evaluates) must end as stage 'timeout'
 * once the wall clock runs out — never as 'supervisor' or 'import' (Node exits
 * at once on an unsettled top-level await unless the event loop is kept alive),
 * and the lines it logged before hanging must reach the output.
 */
void FACTORY_TEST_STATE_DIR;
const store = await import('../src/factory/store.js');
const runner = await import('../src/factory/runner.js');

const HEAD =
  "export const name='t'; export const description='d'; export const parameters={type:'object'};";

function install(id: string, body: string): void {
  const code = `${HEAD}\n${body}`;
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

describe('factory runner: a tool stuck while loading', () => {
  it('a top-level await that never settles ends as timeout', async () => {
    install(
      'tla-hang',
      'await new Promise(() => {});\nexport async function run(){ return "nunca"; }',
    );
    const r = await runner.runFactoryToolSandboxed('tla-hang', {}, { timeoutMs: 4000 });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('timeout');
    expect(r.output).toContain('[timeout 4000ms');
  }, 40_000);

  it('lines logged before a top-level hang reach the output', async () => {
    install(
      'tla-log-hang',
      "console.log('cargando datos'); await new Promise(() => {});\nexport async function run(){ return 'nunca'; }",
    );
    const r = await runner.runFactoryToolSandboxed('tla-log-hang', {}, { timeoutMs: 4000 });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('timeout');
    expect(r.output).toContain('[tool] cargando datos');
  }, 40_000);

  it('a synchronous endless loop while loading ends as timeout', async () => {
    install('sync-loop-load', 'while (true) {}\nexport async function run(){ return "nunca"; }');
    const t0 = Date.now();
    const r = await runner.runFactoryToolSandboxed('sync-loop-load', {}, { timeoutMs: 4000 });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(30_000);
  }, 40_000);
});
