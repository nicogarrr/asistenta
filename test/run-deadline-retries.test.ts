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
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
const stateDir = mkdtempSync(join(tmpdir(), 'pa-run-deadline-'));
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

function _toolCall(id: string, query: string): AssistantMessage {
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

describe('techo de reloj de una corrida con reintentos (runTimeoutMs)', () => {
  it('los reintentos gastan del mismo plazo: pasado runTimeoutMs no se reintenta más', async () => {
    // Cada intento «tarda» 200 ms de reloj; el plazo de la corrida es 300 ms y hay
    // 3 reintentos permitidos. Antes el plazo se reiniciaba en cada intento y la
    // corrida hacía los 4 intentos (≈ 4 × el techo); ahora para en el 2.º.
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    try {
      const transient = scripted(() => {
        skew += 200;
        return fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: '500 Endpoint is unavailable',
        });
      });
      faux.setResponses([transient, transient, transient, transient]);
      const { tool } = fakeTool();
      const agent = await makeAgent(tool, makeGate({}), {
        runTimeoutMs: 300,
        retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
      });
      const result = await agent.run('dime algo');
      expect(contexts).toHaveLength(2);
      expect(result.attempts).toBe(2);
      expect(result.error).toMatch(/500/);
    } finally {
      clock.mockRestore();
    }
  });

  it('dentro del plazo los reintentos siguen funcionando', async () => {
    const fail = scripted(() =>
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: '500 Endpoint is unavailable',
      }),
    );
    faux.setResponses([fail, scripted(() => fauxAssistantMessage('listo'))]);
    const { tool } = fakeTool();
    const agent = await makeAgent(tool, makeGate({}), {
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const result = await agent.run('dime algo');
    expect(result.error).toBeNull();
    expect(result.text).toBe('listo');
    expect(result.attempts).toBe(2);
  });
});
