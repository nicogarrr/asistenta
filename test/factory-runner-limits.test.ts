// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que runner.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { describe, expect, it } from 'vitest';

/**
 * Factory sandbox limits: console output is capped INSIDE the guest (not only
 * after run() ends), console lines stream out while the tool runs, and only
 * well-formed verdicts are accepted.
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

describe('factory runner: limits inside the sandbox', () => {
  it('cuts a tool that logs past the in-sandbox cap at once, not at the timeout', async () => {
    // ~300 KB of logs (over the guest cap, under the 1 MB pipe cap), then hang.
    install(
      'log-then-hang',
      "export async function run(){ for (let i = 0; i < 300; i++) console.log('y'.repeat(1000)); await new Promise(()=>{}); }",
    );
    const r = await runner.runFactoryToolSandboxed('log-then-hang', {}, { timeoutMs: 20_000 });
    expect(r.stage).toBe('output');
    expect(r.ok).toBe(false);
    expect(r.output).toContain(`${runner.MAX_GUEST_LOG_CHARS} caracteres`);
    expect(r.durationMs).toBeLessThan(20_000);
  }, 40_000);

  it('the cap holds even when the tool swallows the console error and returns', async () => {
    install(
      'log-swallow',
      "export async function run(){ for (let i = 0; i < 400; i++) { try { console.log('z'.repeat(1000)); } catch {} } return 'listo'; }",
    );
    const r = await runner.runFactoryToolSandboxed('log-swallow', {}, { timeoutMs: 20_000 });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('output');
  }, 40_000);

  it('the guest cannot reset the counter: the accessors are frozen', async () => {
    install(
      'log-tamper',
      `export async function run(){
  const tries = [];
  try { globalThis.__guestOver = () => false; tries.push('over-escrito'); } catch { tries.push('over-bloqueado'); }
  try { delete globalThis.__guestDrain; tries.push(typeof globalThis.__guestDrain); } catch { tries.push('drain-bloqueado'); }
  return tries.join(',') + ':' + String(globalThis.__guestOver());
}`,
    );
    const r = await runner.runFactoryToolSandboxed('log-tamper', {}, { timeoutMs: 20_000 });
    expect(r.ok).toBe(true);
    expect(r.output).not.toContain('false:');
    expect(r.output).toMatch(/:false$/);
    expect(r.output).toContain('function');
  }, 40_000);

  it('a tool that logs and then hangs shows its lines when the timeout kills it', async () => {
    install(
      'log-hang-short',
      "export async function run(){ console.log('paso 1 hecho'); await new Promise(()=>{}); }",
    );
    const r = await runner.runFactoryToolSandboxed('log-hang-short', {}, { timeoutMs: 6000 });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('timeout');
    expect(r.output).toContain('[tool] paso 1 hecho');
  }, 40_000);

  it('normal logging still works and ends ok', async () => {
    install('log-normal', "export async function run(){ console.log('hola'); return 'fin'; }");
    const r = await runner.runFactoryToolSandboxed('log-normal', {}, { timeoutMs: 20_000 });
    expect(r.ok).toBe(true);
    expect(r.output).toBe('fin');
  }, 40_000);
});

describe('factory runner: pickVerdict only takes well-formed verdicts', () => {
  it('accepts an output-stage failure from the verifier', () => {
    expect(runner.pickVerdict('{"ok":false,"stage":"output","error":"x"}')?.stage).toBe('output');
  });

  it('rejects «ok» with any stage other than run, or without text', () => {
    expect(runner.pickVerdict('{"ok":true,"stage":"import","text":"x"}')).toBeNull();
    expect(runner.pickVerdict('{"ok":true,"stage":"output","text":"x"}')).toBeNull();
    expect(runner.pickVerdict('{"ok":true,"stage":"run"}')).toBeNull();
    expect(runner.pickVerdict('{"ok":true,"stage":"run","text":"x"}')?.ok).toBe(true);
  });

  it('a malformed first line does not shadow the real verdict after it', () => {
    const real = '{"ok":false,"stage":"run","error":"boom"}';
    expect(runner.pickVerdict(`{"ok":true,"stage":"shape","text":"x"}\n${real}`)?.stage).toBe(
      'run',
    );
  });

  it('rejects unknown stages, non-boolean ok, null and arrays', () => {
    expect(runner.pickVerdict('{"ok":false,"stage":"otra"}')).toBeNull();
    expect(runner.pickVerdict('{"ok":"true","stage":"run","text":"x"}')).toBeNull();
    expect(runner.pickVerdict('null')).toBeNull();
    expect(runner.pickVerdict('[true,"run"]')).toBeNull();
  });
});
