import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';

/**
 * The tool factory: build -> subprocess test -> install with approval.
 *
 * Environment is prepared before importing the factory modules because
 * `paths.ts` snapshots `PA_STATE_DIR` at import time (same pattern as
 * budget.test.ts): the factory store must never touch the real state dir.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-factory-'));
process.env.PA_STATE_DIR = stateDir;

const store = await import('../src/factory/store.js');
const runner = await import('../src/factory/runner.js');
const loader = await import('../src/factory/loader.js');
const fab = await import('../src/tools/factory.js');

function resultText(r: { content: { type: string; text?: string }[] }): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

const GOOD_CODE = `export const name = 'eco';
export const description = 'devuelve el texto recibido';
export const parameters = { type: 'object', properties: { msg: { type: 'string' } } };
export async function run(params) { return { text: 'eco:' + (params.msg ?? '') + ':' + String(process.env.PA_STATE_DIR) }; }
`;

function buildMeta(
  id: string,
  over: Partial<import('../src/factory/types.js').FactoryToolMeta> = {},
) {
  const now = new Date().toISOString();
  return {
    id,
    name: id,
    description: 'd',
    whenToUse: 'w',
    version: 1,
    status: 'built' as const,
    createdAt: now,
    updatedAt: now,
    codeSha256: store.sha256(GOOD_CODE),
    testedSha256: null,
    lastTestAt: null,
    lastTestOk: false,
    ...over,
  };
}

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe('factory store', () => {
  it('writes and reads a tool, and lists it', () => {
    store.writeFactoryTool(buildMeta('eco-tool'), GOOD_CODE, 'nota inicial');
    const t = store.readFactoryTool('eco-tool');
    expect(t?.meta.id).toBe('eco-tool');
    expect(t?.meta.status).toBe('built');
    expect(t?.code).toBe(GOOD_CODE);
    expect(t?.notes).toContain('nota inicial');
    expect(store.listFactoryTools().map((m) => m.id)).toContain('eco-tool');
    expect(store.readFactoryTool('no-existe')).toBeNull();
  });

  it('rejects ids that are not slugs', () => {
    expect(() => store.writeFactoryTool(buildMeta('Eco Tool!'), GOOD_CODE, '')).toThrow();
    expect(() => store.readFactoryTool('../etc')).toThrow();
  });
});

describe('factory runner (subprocess)', () => {
  it('runs a good module and does NOT leak the daemon env', async () => {
    store.writeFactoryTool(buildMeta('eco-run'), GOOD_CODE, '');
    const r = await runner.testFactoryTool('eco-run', { msg: 'hola' });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('eco:hola:');
    // The child env is scrubbed: PA_STATE_DIR is set in this test process and
    // must be undefined inside the tool's process.
    expect(r.output).toContain('eco:hola:undefined');
  });

  it('fails at shape when the contract is broken', async () => {
    store.writeFactoryTool(buildMeta('bad-shape'), 'export const name = 42;', '');
    const r = await runner.testFactoryTool('bad-shape', {});
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('shape');
  });

  it('fails at run when run() throws', async () => {
    const code = `export const name='t'; export const description='d'; export const parameters={type:'object'}; export async function run(){ throw new Error('boom'); }`;
    store.writeFactoryTool(buildMeta('bad-run'), code, '');
    const r = await runner.testFactoryTool('bad-run', {});
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('run');
    expect(r.output).toContain('boom');
  });

  it('kills a tool that hangs', async () => {
    const code = `export const name='t'; export const description='d'; export const parameters={type:'object'}; export async function run(){ await new Promise(()=>{}); }`;
    store.writeFactoryTool(buildMeta('hang'), code, '');
    const r = await runner.testFactoryTool('hang', {}, { timeoutMs: 1500 });
    expect(r.ok).toBe(false);
    expect(r.stage).toBe('timeout');
  });
});

describe('factory loader', () => {
  it('wraps installed tools as fab_<id> and executes them', async () => {
    store.writeFactoryTool(buildMeta('eco-inst', { status: 'installed' }), GOOD_CODE, '');
    const tools = await loader.loadInstalledFactoryTools();
    const t = tools.find((x) => x.name === 'fab_eco-inst');
    if (!t) throw new Error('fab_eco-inst no se cargo');
    const res = await t.execute('call1', { msg: 'hi' });
    expect(res.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('eco:hi:'),
    });
  });

  it('does not load disabled or merely built tools', async () => {
    store.writeFactoryTool(buildMeta('eco-off', { status: 'disabled' }), GOOD_CODE, '');
    const tools = await loader.loadInstalledFactoryTools();
    expect(tools.find((x) => x.name === 'fab_eco-off')).toBeUndefined();
    expect(tools.find((x) => x.name === 'fab_eco-tool')).toBeUndefined(); // status built
  });

  it('returns isError instead of throwing when the tool fails at runtime', async () => {
    const code = `export const name='t'; export const description='d'; export const parameters={type:'object'}; export async function run(){ throw new Error('kaput'); }`;
    store.writeFactoryTool(buildMeta('eco-err', { status: 'installed' }), code, '');
    const tools = await loader.loadInstalledFactoryTools();
    const t = tools.find((x) => x.name === 'fab_eco-err') as (typeof tools)[number];
    const res = await t.execute('call2', {});
    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ text: expect.stringContaining('kaput') });
  });
});

describe('fabrica tool (flujo build -> test -> install)', () => {
  it('enforces the order: no install without a passing test of the current code', async () => {
    const tool = fab.createFactoryTool();
    const run = (args: Record<string, unknown>) => tool.execute('c', args as never);

    const built = await run({
      action: 'build',
      name: 'Eco Dos',
      description: 'eco',
      whenToUse: 'probar',
      parameters: { type: 'object' },
      code: GOOD_CODE,
    });
    expect(resultText(built)).toContain('eco-dos');

    // install before test must fail
    await expect(run({ action: 'install', id: 'eco-dos' })).rejects.toThrow(/test/i);

    const tested = await run({ action: 'test', id: 'eco-dos', sampleParams: { msg: 'x' } });
    expect(resultText(tested)).toContain('TEST OK');

    const installed = await run({ action: 'install', id: 'eco-dos' });
    expect(resultText(installed)).toContain('fab_eco-dos');
    expect(store.readFactoryTool('eco-dos')?.meta.status).toBe('installed');
  });

  it('improve retracts the install until a new test passes', async () => {
    const tool = fab.createFactoryTool();
    const run = (args: Record<string, unknown>) => tool.execute('c', args as never);
    await run({
      action: 'build',
      id: 'eco-tres',
      name: 'Eco Tres',
      description: 'eco',
      whenToUse: 'probar',
      parameters: { type: 'object' },
      code: GOOD_CODE,
    });
    await run({ action: 'test', id: 'eco-tres' });
    await run({ action: 'install', id: 'eco-tres' });
    await run({
      action: 'improve',
      id: 'eco-tres',
      code: `${GOOD_CODE}\n// v2\n`,
      note: 'comentario',
    });
    const meta = store.readFactoryTool('eco-tres')?.meta;
    expect(meta?.status).toBe('built');
    expect(meta?.version).toBe(2);
    await expect(run({ action: 'install', id: 'eco-tres' })).rejects.toThrow(/test/i);
  });
});

describe('Gate: fabrica install always asks', () => {
  const installCall = { tool: 'fabrica', args: { action: 'install', id: 'x' }, actor: 'test' };

  it('asks even with an always scope on fabrica', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-fab-gate-'));
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    gate.setScope('s', 'fabrica', 'always');
    const d = await gate.check('s', installCall);
    expect(asked).toBe(1);
    expect(d.verdict).toBe('allow');
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks again for a second identical install (no memo)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-fab-gate-'));
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    await gate.check('s', installCall);
    await gate.check('s', installCall);
    expect(asked).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks even under fullControl with payments allowed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-fab-gate-'));
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      grantWindowMs: 0,
      fullControl: true,
      allowPayments: true,
      approver: () => {
        asked++;
        return true;
      },
    });
    const d = await gate.check('s', installCall);
    expect(asked).toBe(1);
    expect(d.verdict).toBe('allow');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not let the grant window cover an install', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-fab-gate-'));
    let asked = 0;
    // Grant window deliberately wide: any approved tool call opens 90s of trust.
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      approver: () => {
        asked++;
        return true;
      },
    });
    // First an ordinary unlisted tool: asked once, opens the window.
    await gate.check('s', { tool: 'shell', args: { command: 'ls' }, actor: 'test' });
    expect(asked).toBe(1);
    // The install must NOT ride that window.
    await gate.check('s', installCall);
    expect(asked).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});
