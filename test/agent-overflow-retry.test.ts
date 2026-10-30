import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  FauxResponseFactory,
  TranscriptContext,
} from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai';
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
const stateDir = mkdtempSync(join(tmpdir(), 'pa-overflow-retry-'));
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
    sessionId: 'overflow',
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

describe('context overflow retry', () => {
  it('a transient error on the post-compaction retry is still retried', async () => {
    const { tool } = fakeTool();
    faux.setResponses([
      scripted(() =>
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: 'prompt is too long: 1200000 tokens > 1048576 maximum context',
        }),
      ),
      scripted(() =>
        fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 overloaded' }),
      ),
      scripted(() => fauxAssistantMessage('Respuesta tras compactar.')),
    ]);
    const agent = await makeAgent(tool, makeGate({ allow: ['lookup'] }), {
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const result = await agent.run('resume todo');
    expect(result.error).toBeFalsy();
    expect(result.text).toBe('Respuesta tras compactar.');
    expect(contexts).toHaveLength(3);
  });

  it('overflow is retried only once, never in a loop', async () => {
    const { tool } = fakeTool();
    const overflow = (): AssistantMessage =>
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'context length exceeded',
      });
    faux.setResponses([scripted(overflow), scripted(overflow), scripted(overflow)]);
    const agent = await makeAgent(tool, makeGate({ allow: ['lookup'] }), {
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const result = await agent.run('resume todo');
    expect(result.error).toMatch(/context length/);
    expect(contexts).toHaveLength(2);
  });

  it('transient retries after the overflow share the run budget', async () => {
    const { tool } = fakeTool();
    const busy = (): AssistantMessage =>
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: '503 overloaded' });
    faux.setResponses([
      scripted(busy),
      scripted(() =>
        fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'context window exceeded' }),
      ),
      scripted(busy),
      scripted(busy),
      scripted(() => fauxAssistantMessage('no debe llegar')),
    ]);
    const agent = await makeAgent(tool, makeGate({ allow: ['lookup'] }), {
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const result = await agent.run('resume todo');
    // 1 (503) + retry 1 (overflow) + compaction retry (503) + retry 2 (503) = 4 calls.
    expect(contexts).toHaveLength(4);
    expect(result.error).toMatch(/503/);
  });
});
