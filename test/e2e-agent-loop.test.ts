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

describe('agent loop end to end', () => {
  it('runs a tool only after an allow verdict and feeds its result back to the model', async () => {
    const { tool, ran } = fakeTool();
    const gate = makeGate({ allow: ['lookup'] });
    faux.setResponses([
      scripted(() => toolCall('call-1', 'dato')),
      scripted(() => fauxAssistantMessage('La respuesta final usa el resultado.')),
    ]);

    const agent = await makeAgent(tool, gate);
    const result = await agent.run('busca el dato');

    expect(ran).toEqual([{ query: 'dato' }]);
    expect(result.toolCalls).toBe(1);
    expect(result.blocked).toBe(0);
    expect(result.toolErrors).toBe(0);
    expect(result.text).toBe('La respuesta final usa el resultado.');
    expect(result.error).toBeNull();

    // The second provider request carries the tool result, which is the whole
    // contract of the loop: the model cannot use a result it never saw.
    expect(contexts).toHaveLength(2);
    const secondRequest = JSON.stringify(contexts[1]?.messages);
    expect(secondRequest).toContain('resultado-de-la-tool-42');
    expect(secondRequest).toContain('toolResult');
  });

  it('does not run a denied tool and returns the gate reason to the model', async () => {
    const { tool, ran } = fakeTool();
    const gate = makeGate({ deny: ['lookup'] });
    faux.setResponses([
      scripted(() => toolCall('call-denied', 'dato')),
      scripted(() => fauxAssistantMessage('No puedo usar esa herramienta.')),
    ]);

    const agent = await makeAgent(tool, gate);
    const result = await agent.run('busca el dato');

    expect(ran).toEqual([]);
    expect(result.toolCalls).toBe(1);
    expect(result.blocked).toBe(1);
    expect(result.toolErrors).toBe(0);
    expect(result.text).toBe('No puedo usar esa herramienta.');
    expect(JSON.stringify(contexts[1]?.messages)).toContain('tool is on the deny list');
  });

  it('spends one iteration per tool and stops with an empty budget', async () => {
    const { tool, ran } = fakeTool();
    const gate = makeGate({ allow: ['lookup'] });
    faux.setResponses([
      scripted(() => toolCall('call-1', 'uno')),
      scripted(() => toolCall('call-2', 'dos')),
      scripted(() => toolCall('call-3', 'tres')),
      // The loop asks once more after the aborted third call; the abort signal
      // makes the faux provider answer with an aborted message, but the queued
      // step is still consumed.
      scripted(() => fauxAssistantMessage('no deberia llegar al usuario')),
      // One final no-tools turn is the guard's report.
      scripted(() => fauxAssistantMessage('Informe: presupuesto agotado.')),
    ]);

    const agent = await makeAgent(tool, gate, { maxToolCalls: 3 }, 2);
    // `busca` is a level-2 request, so the run ceiling is min(config.maxToolCalls, 25) = 3.
    const result = await agent.run('busca el dato');

    // Two tools ran, consuming the two iterations. The third call starts (and is
    // counted) but the run ceiling aborts it before it executes, which is the
    // hard stop that keeps the soft budget from going negative.
    expect(ran).toHaveLength(2);
    expect(agent.budgetRemaining()).toBe(0);
    expect(result.toolCalls).toBe(3);
    expect(result.text).toBe('Informe: presupuesto agotado.');
    expect(result.error).toBeNull();

    // The exhausted budget reached the model before the third attempt.
    expect(JSON.stringify(contexts[2]?.messages)).toContain(
      'Se ha agotado el presupuesto de esta tarea: 2 pasos.',
    );
  });

  // RunHooks only declares `onToolCall` in src/core/agent.ts; there is no
  // `onTextDelta`, so the delta-concatenation case is intentionally omitted.
});
