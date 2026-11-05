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
const stateDir = mkdtempSync(join(tmpdir(), 'pa-capturas-viejas-'));
// Umbral bajo para el resumen: 10 capturas (15k «tokens» estimados) lo pasaban.
process.env.PA_COMPACT_TOKENS = '10000';
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

const { PersonalAgent, forgetUnsentImages, IMAGES_SENT } = await import('../src/core/agent.js');
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
    sessionId: 'capturas',
    desktop: false,
    iterationBudget: { max: budgetMax },
  });
}

let summaries = 0;
const summarizer = async () => {
  summaries++;
  return fauxAssistantMessage('resumen');
};

beforeEach(() => {
  summaries = 0;
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
    models: { completeSimple: summarizer },
    fallbackFor: undefined,
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const JPEG = 'A'.repeat(200_000); // una captura de ~150 KB en base64

/** Una tarea con el PC ya hecha: 10 capturas en el historial y su respuesta. */
function pcTask(agent: Agent, n = 10): void {
  const msgs = agent.messages as unknown as Array<Record<string, unknown>>;
  msgs.push({ role: 'user', content: [{ type: 'text', text: 'abre el correo' }], timestamp: 1 });
  for (let i = 0; i < n; i++) {
    msgs.push({
      role: 'toolResult',
      toolCallId: `c${i}`,
      toolName: 'screen',
      content: [
        { type: 'text', text: `captura ${i}` },
        { type: 'image', mimeType: 'image/jpeg', data: `${JPEG}${i}` },
      ],
      isError: false,
      timestamp: 2 + i,
    });
  }
}

function imagesIn(messages: unknown[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const c = (m as { content?: unknown }).content;
    if (!Array.isArray(c)) continue;
    for (const b of c as Array<{ type?: string; data?: string }>) {
      if (b.type === 'image') out.push(String(b.data).slice(-1));
    }
  }
  return out;
}

describe('capturas viejas en el historial', () => {
  it('forgetUnsentImages deja solo las que se mandan y no copia si no hace falta', () => {
    const msgs = [
      { role: 'toolResult', content: [{ type: 'image', data: '1' }] },
      { role: 'user', content: [{ type: 'text', text: 'hola' }] },
      {
        role: 'toolResult',
        content: [
          { type: 'image', data: '2' },
          { type: 'image', data: '3' },
        ],
      },
      { role: 'toolResult', content: [{ type: 'image', data: '4' }] },
    ] as never[];
    const out = forgetUnsentImages(msgs) ?? [];
    expect(out).toHaveLength(4);
    expect(imagesIn(out)).toEqual(['2', '3', '4']);
    expect(JSON.stringify(out[0])).toContain('earlier screenshot omitted');
    expect(forgetUnsentImages(out)).toBeNull();
    expect(IMAGES_SENT).toBe(3);
  });

  it('tras una tarea con el PC el siguiente mensaje no paga un resumen por capturas que no se mandan', async () => {
    const { tool } = fakeTool();
    faux.setResponses([scripted(() => fauxAssistantMessage('Hecho.'))]);
    const agent = await makeAgent(tool, makeGate({ allow: ['lookup'] }));
    pcTask(agent, 10);
    const before = agent.messages.length;
    const result = await agent.run('¿y ahora qué?');
    expect(result.error).toBeFalsy();
    // Antes: 10 capturas × 1.500 = 15k «tokens» > 10k → resumen (una llamada más al modelo).
    expect(summaries).toBe(0);
    // El modelo ve lo mismo de siempre: las 3 capturas más recientes.
    expect(imagesIn(contexts[0]?.messages ?? [])).toEqual(['7', '8', '9']);
    // Y el historial en memoria ya no guarda las 7 viejas (≈1,4 MB menos).
    expect(imagesIn(agent.messages)).toEqual(['7', '8', '9']);
    expect(agent.messages.length).toBeGreaterThan(before);
  });
});
