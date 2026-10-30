import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Model } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { formatModelos, parseModelo } from '../src/model-choice.js';

/**
 * F7 /modelo: el agente real con un proveedor falso que anota con qué modelo
 * se llama cada turno. Solo los modelos configurados (PA_MODEL y
 * PA_FALLBACK_MODEL) se pueden elegir, y solo para esta conversación.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-modelo-'));
process.env.PA_STATE_DIR = stateDir;

const providerState = vi.hoisted(() => ({ handle: null as unknown }));
vi.mock('../src/core/provider.js', () => ({
  createProviderHandle: async () => providerState.handle,
}));
vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logHost: vi.fn(),
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const { PersonalAgent } = await import('../src/core/agent.js');
const { Gate } = await import('../src/permissions.js');

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const CONFIG: Config = {
  webMaxCostEur: 0,
  voiceWake: { engine: 'whisper', owwModel: '', owwThreshold: 0.5 },
  provider: 'test-provider',
  model: 'test-model',
  baseUrl: 'http://127.0.0.1:1/v1',
  contextWindowTokens: 1_048_576,
  maxOutputTokens: 32_000,
  dailyBudgetEur: 0,
  toolTimeoutMs: 1_000,
  runTimeoutMs: 5_000,
  idleTimeoutMs: 1_000,
  screenshotMaxEdge: 800,
  screenshotQuality: 75,
  verifyActions: false,
  verifySettleMs: 100,
  cron: [],
  retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  maxToolCalls: 20,
  browserChannel: 'chromium',
  downloadCookiesBrowser: '',
  curlImpersonatePath: '',
};

let faux: ReturnType<typeof createFauxCore>;
let seen: string[] = [];
let gateSeq = 0;

function handle(withModelById: boolean): void {
  const model = faux.getModel();
  const registered: Record<string, Model<string>> = {
    'test-model': model,
    'alt-model': { ...model, id: 'alt-model', name: 'alt-model' },
  };
  providerState.handle = {
    model,
    streamFn: (m: Model<string>, ctx: unknown, opts: unknown) => {
      seen.push(m.id);
      return (faux.streamSimple as (...a: unknown[]) => unknown)(m, ctx, opts);
    },
    modelFor: () => model,
    models: { completeSimple: async () => fauxAssistantMessage('') },
    fallbackFor: undefined,
    modelById: withModelById ? (id: string) => registered[id] : undefined,
  };
}

async function makeAgent(config: Partial<Config> = {}) {
  const gate = new Gate({
    dbPath: join(stateDir, `gate-${gateSeq++}.db`),
    grantWindowMs: 0,
    approver: () => true,
  });
  return PersonalAgent.create({ ...CONFIG, ...config }, [], gate, 'test', {
    sessionId: `modelo-${gateSeq}`,
    desktop: false,
    iterationBudget: { max: 5 },
  });
}

beforeEach(() => {
  seen = [];
  faux = createFauxCore({
    provider: 'test-provider',
    models: [{ id: 'test-model' }],
    tokenSize: { min: 10_000, max: 10_000 },
  });
  handle(true);
});

describe('/modelo: parseo y lista', () => {
  const models = ['test-model', 'alt-model'];
  it('sin argumentos enseña la lista', () => {
    expect(parseModelo('  ', models)).toEqual({ kind: 'show' });
  });
  it('acepta número, nombre exacto o sin mayúsculas, y «normal»', () => {
    expect(parseModelo('2', models)).toEqual({ kind: 'set', id: 'alt-model' });
    expect(parseModelo('ALT-MODEL', models)).toEqual({ kind: 'set', id: 'alt-model' });
    expect(parseModelo('normal', models)).toEqual({ kind: 'set', id: undefined });
  });
  it('rechaza lo que no está configurado sin adivinar', () => {
    expect(parseModelo('3', models).kind).toBe('error');
    expect(parseModelo('gpt-9', models).kind).toBe('error');
    expect(parseModelo('alt', models).kind).toBe('error');
  });
  it('marca el actual y explica cómo tener otro si solo hay uno', () => {
    const text = formatModelos(models, 'alt-model');
    expect(text).toContain('✓ 2. alt-model');
    expect(text).toContain('  1. test-model (principal)');
    expect(formatModelos(['test-model'], 'test-model')).toContain('PA_FALLBACK_MODEL');
  });
});

describe('/modelo: PersonalAgent.chooseModel', () => {
  it('lista PA_MODEL y PA_FALLBACK_MODEL sin repetir', async () => {
    const agent = await makeAgent({ fallbackModel: 'alt-model' });
    expect(agent.availableModels).toEqual(['test-model', 'alt-model']);
    const same = await makeAgent({ fallbackModel: 'test-model' });
    expect(same.availableModels).toEqual(['test-model']);
  });

  it('el turno siguiente va al modelo elegido y «normal» vuelve al principal', async () => {
    const agent = await makeAgent({ fallbackModel: 'alt-model' });
    faux.setResponses([
      fauxAssistantMessage('uno'),
      fauxAssistantMessage('dos'),
      fauxAssistantMessage('tres'),
    ]);
    await agent.run('hola');
    expect(seen.at(-1)).toBe('test-model');

    expect(agent.chooseModel('alt-model')).toEqual({ ok: true, model: 'alt-model' });
    expect(agent.modelId).toBe('alt-model');
    await agent.run('otra');
    expect(seen.at(-1)).toBe('alt-model');

    expect(agent.chooseModel(undefined)).toEqual({ ok: true, model: 'test-model' });
    expect(agent.modelId).toBe('test-model');
    await agent.run('y otra');
    expect(seen.at(-1)).toBe('test-model');
  });

  it('un modelo no configurado no cambia nada', async () => {
    const agent = await makeAgent({ fallbackModel: 'alt-model' });
    const r = agent.chooseModel('otro-modelo');
    expect(r.ok).toBe(false);
    expect(agent.modelId).toBe('test-model');
  });

  it('si el proveedor no sabe cambiar de modelo, lo dice y no cambia', async () => {
    handle(false);
    const agent = await makeAgent({ fallbackModel: 'alt-model' });
    const r = agent.chooseModel('alt-model');
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('no permite') });
    expect(agent.modelId).toBe('test-model');
  });
});
