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

const { PersonalAgent, rewindFailedAttempt } = await import('../src/core/agent.js');
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

const PROMPT = 'reserva mesa para dos el viernes';

function userCopies(context: TranscriptContext | undefined): number {
  return (context?.messages ?? []).filter(
    (m) => m.role === 'user' && JSON.stringify(m.content).includes(PROMPT),
  ).length;
}

describe('reintento por fallo transitorio: el contexto no duplica el mensaje del usuario', () => {
  it('un fallo antes de cualquier herramienta: el reintento lleva UNA copia del mensaje', async () => {
    const { tool } = fakeTool();
    const gate = makeGate({ allow: ['lookup'] });
    faux.setResponses([
      scripted(() =>
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: '500 Endpoint is unavailable',
        }),
      ),
      scripted(() => fauxAssistantMessage('Hecho.')),
    ]);
    const agent = await makeAgent(tool, gate, {
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const result = await agent.run(PROMPT);
    expect(result.error).toBeNull();
    expect(result.text).toBe('Hecho.');
    expect(contexts).toHaveLength(2);
    expect(userCopies(contexts[1])).toBe(1);
  });

  it('dos fallos seguidos: el tercer intento sigue llevando una sola copia', async () => {
    const { tool } = fakeTool();
    const gate = makeGate({ allow: ['lookup'] });
    const fail = () =>
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: '500 Endpoint is unavailable',
      });
    faux.setResponses([
      scripted(fail),
      scripted(fail),
      scripted(() => fauxAssistantMessage('Hecho.')),
    ]);
    const agent = await makeAgent(tool, gate, {
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const result = await agent.run(PROMPT);
    expect(result.text).toBe('Hecho.');
    expect(userCopies(contexts[2])).toBe(1);
  });

  it('fallo tras ejecutar una herramienta: se conserva su resultado y el aviso de recuperación, sin repetir el mensaje', async () => {
    const { tool, ran } = fakeTool();
    const gate = makeGate({ allow: ['lookup'] });
    faux.setResponses([
      scripted(() => toolCall('call-1', 'mesas')),
      scripted(() =>
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: '500 Endpoint is unavailable',
        }),
      ),
      scripted(() => fauxAssistantMessage('Reservado.')),
    ]);
    const agent = await makeAgent(tool, gate, {
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const result = await agent.run(PROMPT);
    expect(ran).toHaveLength(1);
    expect(result.text).toBe('Reservado.');
    const retry = contexts[2];
    expect(userCopies(retry)).toBe(1);
    const wire = JSON.stringify(retry?.messages);
    expect(wire).toContain('resultado-de-la-tool-42');
    expect(wire).toContain('YA se ejecutaron');
  });

  it('la historia que queda tras el turno tampoco arrastra copias del mensaje', async () => {
    const { tool } = fakeTool();
    const gate = makeGate({ allow: ['lookup'] });
    faux.setResponses([
      scripted(() =>
        fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: '500 Endpoint is unavailable',
        }),
      ),
      scripted(() => fauxAssistantMessage('Hecho.')),
      scripted(() => fauxAssistantMessage('Siguiente.')),
    ]);
    const agent = await makeAgent(tool, gate, {
      retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    await agent.run(PROMPT);
    await agent.run('y otra cosa');
    expect(userCopies(contexts[2])).toBe(1);
  });
});

describe('rewindFailedAttempt (pura)', () => {
  const user = (t: string) => ({
    role: 'user',
    content: [{ type: 'text', text: t }],
    timestamp: 0,
  });
  const dead = (stopReason: 'error' | 'aborted') => ({
    role: 'assistant',
    content: [],
    stopReason,
  });
  const ok = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' };
  const tr = { role: 'toolResult', content: [{ type: 'text', text: 'r' }] };
  // biome-ignore lint/suspicious/noExplicitAny: mensajes de prueba mínimos
  const rw = (m: any[], s: number) => rewindFailedAttempt(m as any, s);

  it('quita el mensaje del intento y su error cuando no hizo nada', () => {
    const before = [user('antes'), ok, user('p'), dead('error')];
    expect(rw(before, 2)).toEqual([user('antes'), ok]);
    expect(before).toHaveLength(4);
  });
  it('conserva el trabajo de herramientas y solo quita los errores finales', () => {
    const tc = { role: 'assistant', content: [], stopReason: 'toolUse' };
    expect(rw([user('p'), tc, tr, dead('error'), dead('aborted')], 0)).toEqual([user('p'), tc, tr]);
  });
  it('no toca lo anterior al inicio ni un inicio fuera de rango', () => {
    expect(rw([user('a'), dead('error')], 5)).toEqual([user('a'), dead('error')]);
    expect(rw([user('p')], 0)).toEqual([]);
  });
});
