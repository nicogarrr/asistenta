import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * Gap #6 (Hermes «credential pools», OpenClaw «model failover», Crocbot «API key
 * round-robin»): antes había UN respaldo y UNA clave. Con la cuota del día agotada
 * en la clave y en el respaldo, la respuesta moría aunque Nico tuviera otra clave
 * u otro modelo gratis. Bucle real de PersonalAgent con un proveedor de guion.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-respaldo-cadena-'));
process.env.PA_STATE_DIR = stateDir;
process.env.PA_VAULT_BACKEND = 'portable';
process.env.PA_SECRET_PROVIDER_APIKEY = 'test-key-never-used';
process.env.PA_API_KEY = 'test-key-never-used';

const providerState = vi.hoisted(() => ({ handle: null as unknown }));
vi.mock('../src/core/provider.js', async (orig) => ({
  ...(await orig<typeof import('../src/core/provider.js')>()),
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

type FauxCore = ReturnType<typeof createFauxCore>;

let faux: FauxCore;
let wire: string[];

const quota = (): AssistantMessage =>
  fauxAssistantMessage('', { stopReason: 'error', errorMessage: '429 daily quota exhausted' });
const ok = (): AssistantMessage => fauxAssistantMessage('hecho');

function handle(opts: { chain: string[]; keys: boolean[] }) {
  const model = faux.getModel();
  const named = (id: string) => ({ ...model, id }) as typeof model;
  let keyTurns = [...opts.keys];
  const rotateKey = vi.fn(() => keyTurns.shift() ?? false);
  providerState.handle = {
    model,
    streamFn: ((m: { id: string }, ctx: unknown, o: unknown) => {
      wire.push(m.id);
      return (faux.streamSimple as (...a: unknown[]) => unknown)(m, ctx, o);
    }) as never,
    modelFor: () => model,
    models: { completeSimple: async () => fauxAssistantMessage('') },
    fallbackFor: opts.chain.length ? () => named(opts.chain[0] as string) : undefined,
    fallbackChainFor: opts.chain.length ? () => opts.chain.map(named) : undefined,
    rotateKey: opts.keys.length ? rotateKey : undefined,
  };
  return {
    rotateKey,
    reset: (k: boolean[]) => {
      keyTurns = [...k];
    },
  };
}

async function agent(attempts: number) {
  const gate = new Gate({
    dbPath: join(stateDir, `gate-${Math.random()}.db`),
    grantWindowMs: 0,
    approver: () => true,
  });
  return PersonalAgent.create(
    { ...CONFIG, retry: { attempts, baseDelayMs: 1, maxDelayMs: 1 } },
    [],
    gate,
    'test',
    {
      sessionId: 'respaldo',
      desktop: false,
      iterationBudget: { max: 5 },
    },
  );
}

beforeEach(() => {
  wire = [];
  faux = createFauxCore({
    provider: 'test-provider',
    models: [{ id: 'test-model' }],
    tokenSize: { min: 10_000, max: 10_000 },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cadena de respaldo y claves que se turnan', () => {
  it('429: otra clave con el mismo modelo, luego el respaldo 1 y luego el 2', async () => {
    const h = handle({ chain: ['respaldo-1', 'respaldo-2'], keys: [true, false, false] });
    faux.setResponses([quota, quota, quota, ok]);
    const a = await agent(2);
    const result = await a.run('hola');
    expect(result.error).toBeFalsy();
    expect(result.text).toBe('hecho');
    // principal (clave 1) → principal (clave 2) → respaldo-1 → respaldo-2.
    expect(wire).toEqual(['test-model', 'test-model', 'respaldo-1', 'respaldo-2']);
    expect(h.rotateKey).toHaveBeenCalledTimes(3);

    // La siguiente respuesta vuelve a empezar por el principal.
    wire = [];
    h.reset([]);
    faux.setResponses([ok]);
    await a.run('otra');
    expect(wire).toEqual(['test-model']);
  });

  it('con un solo respaldo y una clave hace lo mismo que antes', async () => {
    handle({ chain: ['respaldo-1'], keys: [] });
    faux.setResponses([quota, quota, quota, ok]);
    const result = await (await agent(2)).run('hola');
    expect(wire).toEqual(['test-model', 'respaldo-1', 'respaldo-1']);
    expect(result.error).toMatch(/429/);
  });
});

describe('KeyPool', async () => {
  const { KeyPool, parseExtraKeys } = await import('../src/core/key-pool.js');
  it('turna las claves, aparca la agotada una hora y vuelve sola a la principal', () => {
    let now = 0;
    const pool = new KeyPool(['k1', 'k2', 'k3', 'k2', ' '], { now: () => now });
    expect(pool.size).toBe(3);
    expect(pool.current()).toBe('k1');
    expect(pool.rotate()).toBe(true);
    expect(pool.current()).toBe('k2');
    expect(pool.rotate()).toBe(true);
    expect(pool.current()).toBe('k3');
    expect(pool.rotate()).toBe(false);
    now += 60 * 60 * 1000;
    expect(pool.current()).toBe('k1');
  });

  it('una sola clave no rota; PA_EXTRA_API_KEYS admite comas y espacios', () => {
    expect(new KeyPool(['k1']).rotate()).toBe(false);
    expect(parseExtraKeys(' a, b  c,a ')).toEqual(['a', 'b', 'c']);
    expect(parseExtraKeys(undefined)).toEqual([]);
  });
});

describe('fallbackChainIds', async () => {
  const { fallbackChainIds } = await import('../src/core/provider.js');
  it('PA_FALLBACK_MODEL y luego PA_FALLBACK_MODELS, sin repetir ni el principal', () => {
    expect(
      fallbackChainIds({ model: 'a', fallbackModel: 'b', fallbackModels: ['c', 'b', 'a', 'd'] }),
    ).toEqual(['b', 'c', 'd']);
    expect(fallbackChainIds({ model: 'a', fallbackModels: ['c'] })).toEqual(['c']);
    expect(fallbackChainIds({ model: 'a' })).toEqual([]);
  });
});
