import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  FauxResponseFactory,
  TranscriptContext,
} from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * End-to-end loop against a scripted provider: the real `PersonalAgent` and the
 * real `Gate`, a fake model that answers from a queue, and fake tools that record
 * whether they ever ran. No network and no real state dir.
 *
 * The provider handle is mocked because `PersonalAgent.create` builds one
 * internally; every other moving part (agent loop, gate, budget, hooks) is the
 * production implementation.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-loop-evals-'));
process.env.PA_STATE_DIR = stateDir;
process.env.PA_VAULT_BACKEND = 'portable';
process.env.PA_SECRET_PROVIDER_APIKEY = 'test-key-never-used';
process.env.PA_API_KEY = 'test-key-never-used';

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

type FauxCore = ReturnType<typeof createFauxCore>;
type Agent = Awaited<ReturnType<typeof PersonalAgent.create>>;

let faux: FauxCore;
let contexts: TranscriptContext[];

/** One scripted model turn, recording the context the provider received. */
function scripted(build: () => AssistantMessage): FauxResponseFactory {
  return (context) => {
    contexts.push(context);
    return build();
  };
}

function toolCall(id: string, query: string): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall('lookup', { query }, { id })], {
    stopReason: 'toolUse',
  });
}

function fakeTool(): { tool: AgentTool; ran: Record<string, unknown>[] } {
  const ran: Record<string, unknown>[] = [];
  const tool = {
    name: 'lookup',
    label: 'lookup',
    description: 'fake lookup tool',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    execute: async (_id: string, args: unknown) => {
      ran.push(args as Record<string, unknown>);
      return { content: [{ type: 'text', text: 'resultado-de-la-tool-42' }], details: {} };
    },
  } as unknown as AgentTool;
  return { tool, ran };
}

let gateSeq = 0;

function makeGate(options: { allow?: string[]; deny?: string[] }): InstanceType<typeof Gate> {
  return new Gate({
    dbPath: join(stateDir, `gate-${gateSeq++}.db`),
    grantWindowMs: 0,
    allow: options.allow,
    deny: options.deny,
    approver: () => true,
  });
}

async function makeAgent(
  tool: AgentTool,
  gate: InstanceType<typeof Gate>,
  config: Partial<Config> = {},
  budgetMax = 5,
): Promise<Agent> {
  return PersonalAgent.create({ ...CONFIG, ...config }, [tool], gate, 'test', {
    sessionId: 'evals',
    desktop: false,
    iterationBudget: { max: budgetMax },
  });
}

beforeEach(() => {
  contexts = [];
  faux = createFauxCore({
    provider: 'test-provider',
    models: [{ id: 'test-model' }],
    // One chunk per text block: deterministic deltas without depending on Math.random.
    tokenSize: { min: 10_000, max: 10_000 },
  });
  const model = faux.getModel();
  providerState.handle = {
    model,
    streamFn: faux.streamSimple,
    modelFor: () => model,
    models: { completeSimple: async () => fauxAssistantMessage('') },
    fallbackFor: undefined,
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Messages left in history that carry nothing a later turn could use. */
function junk(agent: Agent): unknown[] {
  // The first message is the system prompt itself.
  return agent.messages.slice(1).filter((m) => {
    const msg = m as { role?: string; content?: unknown };
    if (!['user', 'assistant', 'toolResult'].includes(String(msg.role))) return true;
    if (msg.role === 'user') {
      const c = msg.content;
      const text = Array.isArray(c)
        ? c.map((b: { text?: unknown }) => (typeof b?.text === 'string' ? b.text : 'x')).join('')
        : String(c ?? '');
      return text.trim() === '' || text.includes('Ya no tienes herramientas');
    }
    if (msg.role === 'toolResult') return JSON.stringify(msg.content).includes('not found');
    const a = m as { stopReason?: string };
    return a.stopReason === 'aborted' || a.stopReason === 'error';
  });
}

/**
 * Deterministic evals for the agent loop: retries, loop guard and tool budget,
 * scored against a scripted provider so a regression in loop quality fails CI
 * instead of waiting for a live-LLM battery.
 */
describe('agent loop evals (fake model)', () => {
  it('retry: transient errors are retried up to the policy, then reported', async () => {
    const { tool } = fakeTool();
    const busy = (): AssistantMessage =>
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 overloaded' });
    faux.setResponses([scripted(busy), scripted(busy), scripted(busy), scripted(busy)]);
    const agent = await makeAgent(tool, makeGate({ allow: ['lookup'] }), {
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const result = await agent.run('hola');
    expect(contexts).toHaveLength(3);
    expect(result.attempts).toBe(3);
    expect(result.error).toMatch(/503/);
    // The prompt is in history once, not once per attempt.
    const prompts = agent.messages.filter((m) => (m as { role?: string }).role === 'user');
    expect(prompts).toHaveLength(1);
  });

  it('retry: a permanent error (401) is never retried', async () => {
    const { tool } = fakeTool();
    faux.setResponses([
      scripted(() =>
        fauxAssistantMessage('', { stopReason: 'error', errorMessage: '401 invalid api key' }),
      ),
      scripted(() => fauxAssistantMessage('no debe llegar')),
    ]);
    const agent = await makeAgent(tool, makeGate({ allow: ['lookup'] }), {
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const result = await agent.run('hola');
    expect(contexts).toHaveLength(1);
    expect(result.error).toMatch(/401/);
  });

  it('retry: work done before a transient failure is kept, the tool does not run twice', async () => {
    const { tool, ran } = fakeTool();
    faux.setResponses([
      scripted(() => toolCall('c1', 'uno')),
      scripted(() =>
        fauxAssistantMessage('', { stopReason: 'error', errorMessage: '429 rate limit' }),
      ),
      scripted(() => fauxAssistantMessage('Hecho.')),
    ]);
    const agent = await makeAgent(tool, makeGate({ allow: ['lookup'] }), {
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const result = await agent.run('busca uno');
    expect(result.text).toBe('Hecho.');
    expect(ran).toHaveLength(1);
    expect(JSON.stringify(contexts[2])).toContain('resultado-de-la-tool-42');
  });

  it('loop guard: the same call repeated is stopped and reported, history stays clean', async () => {
    const { tool, ran } = fakeTool();
    const responses: FauxResponseFactory[] = [];
    for (let i = 0; i < 12; i++) responses.push(scripted(() => toolCall(`l${i}`, 'igual')));
    responses.push(scripted(() => fauxAssistantMessage('Me he quedado atascado buscando.')));
    faux.setResponses(responses);
    const agent = await makeAgent(tool, makeGate({ allow: ['lookup'] }), {}, 50);
    const result = await agent.run('busca igual');
    expect(ran.length).toBeLessThan(12);
    expect(result.text).toBe('Me he quedado atascado buscando.');
    expect(result.error).toBeFalsy();
    expect(junk(agent)).toEqual([]);
  });

  it('budget: the iteration budget stops the run with a report, history stays clean', async () => {
    const { tool, ran } = fakeTool();
    const responses: FauxResponseFactory[] = [];
    for (let i = 0; i < 8; i++) responses.push(scripted(() => toolCall(`b${i}`, `q${i}`)));
    responses.push(scripted(() => fauxAssistantMessage('Presupuesto agotado: llevo 3 de 8.')));
    faux.setResponses(responses);
    const agent = await makeAgent(tool, makeGate({ allow: ['lookup'] }), { maxToolCalls: 3 }, 3);
    const result = await agent.run('busca ocho cosas');
    expect(ran.length).toBeLessThanOrEqual(4);
    expect(result.text).toContain('Presupuesto agotado');
    expect(junk(agent)).toEqual([]);
    // A later turn still has its tools and a fresh budget.
    faux.setResponses([
      scripted(() => toolCall('n1', 'nuevo')),
      scripted(() => fauxAssistantMessage('Turno nuevo bien.')),
    ]);
    const next = await agent.run('otra cosa');
    expect(next.text).toBe('Turno nuevo bien.');
    expect(ran.at(-1)).toEqual({ query: 'nuevo' });
  });

  it('gate: a denied tool never runs and is counted as blocked', async () => {
    const { tool, ran } = fakeTool();
    faux.setResponses([
      scripted(() => toolCall('d1', 'secreto')),
      scripted(() => fauxAssistantMessage('No tengo permiso.')),
    ]);
    const agent = await makeAgent(tool, makeGate({ deny: ['lookup'] }));
    const result = await agent.run('busca secreto');
    expect(ran).toHaveLength(0);
    expect(result.blocked).toBe(1);
    expect(result.text).toBe('No tengo permiso.');
  });
});
