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
 * Como Tab: si algo falla a mitad, una línea honesta que dice qué y qué prueba ahora.
 * Modelo falso (cola de respuestas) y el bucle real del agente; Telegram falso.
 *
 * End-to-end loop against a scripted provider: the real `PersonalAgent` and the
 * real `Gate`, a fake model that answers from a queue, and fake tools that record
 * whether they ever ran. No network and no real state dir.
 *
 * The provider handle is mocked because `PersonalAgent.create` builds one
 * internally; every other moving part (agent loop, gate, budget, hooks) is the
 * production implementation.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-como-tab-fallo-'));
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
const { TurnSetbacks, setbackLine, MAX_SETBACKS } = await import('../src/daemon/turn-ack.js');

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

function failingTool(): AgentTool {
  return {
    name: 'lookup',
    label: 'lookup',
    description: 'fake lookup tool that fails',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    execute: async () => {
      throw new Error('ECONNRESET 10.0.0.1:993');
    },
  } as unknown as AgentTool;
}

describe('fin de herramienta: el agente avisa si salió bien o mal', () => {
  it('una herramienta que falla llega como ok:false, sin el error en crudo', async () => {
    const gate = makeGate({ allow: ['lookup'] });
    faux.setResponses([
      scripted(() => toolCall('call-1', 'dato')),
      scripted(() => fauxAssistantMessage('No he podido.')),
    ]);
    const agent = await makeAgent(failingTool(), gate);
    const ends: unknown[] = [];
    await agent.run('busca el dato', undefined, { onToolEnd: (i) => ends.push(i) });
    expect(ends).toEqual([{ tool: 'lookup', ok: false, blocked: false }]);
  });

  it('una que sale bien llega como ok:true', async () => {
    const { tool } = fakeTool();
    const gate = makeGate({ allow: ['lookup'] });
    faux.setResponses([
      scripted(() => toolCall('call-1', 'dato')),
      scripted(() => fauxAssistantMessage('Hecho.')),
    ]);
    const agent = await makeAgent(tool, gate);
    const ends: unknown[] = [];
    await agent.run('busca el dato', undefined, { onToolEnd: (i) => ends.push(i) });
    expect(ends).toEqual([{ tool: 'lookup', ok: true, blocked: false }]);
  });

  it('un «no» de los permisos va marcado como bloqueo, no como fallo', async () => {
    const { tool } = fakeTool();
    const gate = makeGate({ deny: ['lookup'] });
    faux.setResponses([
      scripted(() => toolCall('call-1', 'dato')),
      scripted(() => fauxAssistantMessage('No me deja.')),
    ]);
    const agent = await makeAgent(tool, gate);
    const ends: { blocked: boolean }[] = [];
    await agent.run('busca el dato', undefined, { onToolEnd: (i) => ends.push(i) });
    expect(ends.every((e) => e.blocked)).toBe(true);
  });
});

describe('aviso honesto de fallo en el chat', () => {
  function chat(enabled = () => true) {
    const sent: string[] = [];
    return { sent, s: new TurnSetbacks({ show: (t) => void sent.push(t), enabled }) };
  }

  it('dice qué ha fallado en llano y qué prueba ahora', () => {
    const { sent, s } = chat();
    expect(s.toolEnded({ tool: 'correo', ok: false, blocked: false })).toBe(true);
    expect(sent[0]).toMatch(/^No me ha salido a la primera con tu correo; /);
    expect(sent[0]).toMatch(/pruebo|intento|camino/);
  });

  it('nada si salió bien o si fue un bloqueo de permisos', () => {
    const { sent, s } = chat();
    s.toolEnded({ tool: 'correo', ok: true, blocked: false });
    s.toolEnded({ tool: 'browser', ok: false, blocked: true });
    expect(sent).toEqual([]);
  });

  it('una vez por tarea y como mucho dos por turno', () => {
    const { sent, s } = chat();
    for (const tool of ['browser', 'browser', 'fetch', 'correo', 'computer', 'tv'])
      s.toolEnded({ tool, ok: false, blocked: false });
    expect(sent).toHaveLength(MAX_SETBACKS);
    expect(sent[0]).toMatch(/la web/);
    expect(sent[1]).toMatch(/tu correo/);
  });

  it('respeta /estado off', () => {
    const { sent, s } = chat(() => false);
    s.toolEnded({ tool: 'correo', ok: false, blocked: false });
    expect(sent).toEqual([]);
  });

  it('nunca nombra la herramienta', () => {
    for (const tool of ['shell', 'browser', 'x_rara']) {
      expect(setbackLine(tool, () => 0)).not.toMatch(/shell|browser|x_rara/);
      expect(setbackLine(tool, () => 1).length).toBeLessThanOrEqual(80);
    }
  });

  it('el turno de Telegram lo usa', async () => {
    const { readFileSync } = await import('node:fs');
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('setbacks.toolEnded(info)');
  });
});
