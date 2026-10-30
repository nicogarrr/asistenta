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

const { PersonalAgent, dropGuardPrompt } = await import('../src/core/agent.js');
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

describe('informe tras el guard: su instrucción no se queda en la historia', () => {
  it('el siguiente turno no ve «Ya no tienes herramientas»', async () => {
    const { tool } = fakeTool();
    const gate = makeGate({ allow: ['lookup'] });
    faux.setResponses([
      scripted(() => toolCall('c1', 'igual')),
      scripted(() => toolCall('c2', 'igual')),
      scripted(() => toolCall('c3', 'igual')),
      scripted(() => toolCall('c4', 'igual')),
      scripted(() => fauxAssistantMessage('Me atasqué buscando; dime otra pista.')),
      scripted(() => fauxAssistantMessage('Hola de nuevo.')),
    ]);
    const agent = await makeAgent(tool, gate, {}, 20);
    const first = await agent.run('busca el dato');
    expect(first.text).toBe('Me atasqué buscando; dime otra pista.');
    // La petición del informe sí lleva la instrucción…
    const reportReq = contexts.find((c) =>
      JSON.stringify(c.messages).includes('Ya no tienes herramientas'),
    );
    expect(reportReq).toBeDefined();
    const second = await agent.run('otra cosa');
    expect(second.text).toBe('Hola de nuevo.');
    // …pero la del turno siguiente no, y conserva lo que se le dijo al usuario.
    const next = JSON.stringify(contexts.at(-1)?.messages);
    expect(next).not.toContain('Ya no tienes herramientas');
    expect(next).toContain('Me atasqué buscando');
    expect(
      agent.messages.some((m) => JSON.stringify(m).includes('Ya no tienes herramientas')),
    ).toBe(false);
  });
});

describe('dropGuardPrompt (pura)', () => {
  const user = (t: string) => ({ role: 'user', content: t });
  const asst = (t: string, stopReason = 'stop') => ({ role: 'assistant', content: t, stopReason });
  // biome-ignore lint/suspicious/noExplicitAny: mensajes mínimos
  const d = (m: any[], at: number) => dropGuardPrompt(m as any, at, 'GUARD');
  it('quita la instrucción y deja el informe', () => {
    expect(d([user('p'), user('GUARD'), asst('informe')], 1)).toEqual([user('p'), asst('informe')]);
  });
  it('encuentra la instrucción aunque pi meta antes su marcador de herramientas', () => {
    const marker = { role: 'system', content: '' };
    expect(d([user('p'), marker, user('GUARD'), asst('informe')], 1)).toEqual([
      user('p'),
      marker,
      asst('informe'),
    ]);
  });
  it('un informe fallido no deja rastro', () => {
    expect(d([user('p'), user('GUARD'), asst('', 'error')], 1)).toEqual([user('p')]);
  });
});
