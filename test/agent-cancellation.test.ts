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
const stateDir = mkdtempSync(join(tmpdir(), 'pa-e2e-agent-'));
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
    sessionId: 'e2e',
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

describe('agent cancellation and guard timer lifetime', () => {
  it('external stop releases a retry backoff immediately and never calls the provider again', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { tool } = fakeTool();
    faux.setResponses([
      scripted(() =>
        fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 overloaded' }),
      ),
      scripted(() => fauxAssistantMessage('must not run')),
    ]);
    const agent = await makeAgent(tool, makeGate({ allow: ['lookup'] }), {
      retry: { attempts: 3, baseDelayMs: 20_000, maxDelayMs: 20_000 },
    });
    let settled = false;
    const run = agent.run('consulta').then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(contexts).toHaveLength(1);
    expect(settled).toBe(false);
    agent.abort('external');
    await vi.advanceTimersByTimeAsync(0);
    const settledOnStop = settled;
    await vi.advanceTimersByTimeAsync(20_000);
    await run;
    expect(contexts).toHaveLength(1);
    expect(settledOnStop).toBe(true);
  });

  it('a quick guard report does not leave a timeout that aborts a later turn', async () => {
    vi.useFakeTimers();
    const { tool } = fakeTool();
    faux.setResponses([
      scripted(() => toolCall('call-1', 'uno')),
      scripted(() => toolCall('call-2', 'dos')),
      scripted(() => toolCall('call-3', 'tres')),
      scripted(() => fauxAssistantMessage('interrupted')),
      scripted(() => fauxAssistantMessage('Informe: presupuesto agotado.')),
    ]);
    const agent = await makeAgent(tool, makeGate({ allow: ['lookup'] }), { maxToolCalls: 3 }, 2);
    const run = agent.run('busca el dato');
    await vi.advanceTimersByTimeAsync(10);
    const result = await run;
    expect(result.text).toBe('Informe: presupuesto agotado.');
    const abort = vi.spyOn(agent.agent, 'abort');
    faux.setResponses([scripted(() => fauxAssistantMessage('Turno posterior completo.'))]);
    const next = agent.run('hola');
    await vi.advanceTimersByTimeAsync(10);
    expect((await next).text).toBe('Turno posterior completo.');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(abort).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
