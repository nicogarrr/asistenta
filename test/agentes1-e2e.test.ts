import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, FauxResponseFactory } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * Escenarios de punta a punta de los especialistas (agentes-e2e-1), mismo arnés
 * que expertos2-e2e:
 * una petición que se parte en dos especialistas («apaga la tele y mira mi
 * correo»), Nico diciendo que no, un especialista que no existe, y qué pasa
 * cuando no hay forma de preguntar. PersonalAgent y Gate reales: sin red, sin
 * tele, sin correo de verdad.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-agentes1-e2e-'));
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
const { createDelegateWiring } = await import('../src/core/subagent-wiring.js');
const { createDaemonGate } = await import('../src/daemon/gate.js');

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const CONFIG = {
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
} as unknown as Config;

const ran: Array<{ name: string; action?: unknown }> = [];
function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `descripcion original de ${name}`,
    parameters: { type: 'object', properties: { action: { type: 'string' } } },
    execute: async (_id: string, args: Record<string, unknown> | undefined) => {
      ran.push({ name, action: args?.action });
      return { content: [{ type: 'text', text: `ok-${name}` }], details: {} };
    },
  } as unknown as AgentTool;
}

const THREAD = [
  'memory',
  'reminder',
  'read',
  'list',
  'fetch',
  'web',
  'shell',
  'correo',
  'calendar',
  'festivos',
  'tv',
  'computer',
  'windows',
  'casa',
].map(tool);
const PROCESS = ['read', 'list', 'fetch', 'web'].map(tool);

let faux: ReturnType<typeof createFauxCore>;
let questions: string[];
let childTools: Record<string, string[]>;

function call(name: string, args: Record<string, unknown>, id: string) {
  return fauxToolCall(name, args as never, { id });
}

/** Quien habla segun su propio contexto: el principal o el especialista X. */
function whoIs(context: unknown): string {
  const text = JSON.stringify((context as { messages?: unknown }).messages ?? []);
  const m = text.match(/Eres el especialista (?:de la |de |del )?(\w+)/);
  if (m?.[1]) return m[1].toLowerCase();
  if (text.includes('Rol EXPLORER')) return 'generico';
  return 'principal';
}

function steps(context: unknown): number {
  const msgs = (context as { messages?: Array<{ role?: string }> }).messages ?? [];
  return msgs.filter((m) => m.role === 'assistant').length;
}

type Script = Record<string, Array<() => AssistantMessage>>;
function play(script: Script): FauxResponseFactory {
  return (context) => {
    const who = whoIs(context);
    const step = steps(context);
    const next = script[who]?.[step];
    if (!next) return fauxAssistantMessage(`(${who} sin guion en el paso ${step})`);
    return next();
  };
}

type Approve = 'si' | 'no' | 'sin-canal' | 'falla';

interface Outcome {
  text: string;
  /** Especialistas que terminaron, tal y como los ve el panel (onToolEnd). */
  specialists: string[];
}

async function principal(
  userText: string,
  script: Script,
  approve: Approve | ((q: string) => Promise<boolean>),
  pool?: { timeoutMs?: number; maxConcurrent?: number },
): Promise<Outcome> {
  const w = createDelegateWiring({
    config: CONFIG,
    ...(pool ? { pool } : {}),
    parentTools: () => PROCESS,
    createAgent: (config, tools, gate, actor, opts) => {
      childTools[actor + Object.keys(childTools).length] = tools.map((t) => t.name);
      return PersonalAgent.create(config, tools, gate, actor, opts);
    },
  });
  const delegate =
    approve === 'sin-canal'
      ? w.forThread(() => THREAD)
      : w.forThread(
          () => THREAD,
          async (q) => {
            questions.push(q);
            if (typeof approve === 'function') return approve(q);
            if (approve === 'falla') throw new Error('Telegram caído');
            return approve === 'si';
          },
        );
  const parentGate = createDaemonGate({
    threadKey: 'telegram:dm:1#main',
    dbPath: join(stateDir, 'aprobaciones-agentes1.db'),
    ask: async () => ({ approved: false, scope: 'once' }) as never,
  });
  faux.setResponses(Array.from({ length: 40 }, () => play(script)));
  const agent = await PersonalAgent.create(
    CONFIG,
    [delegate, ...THREAD],
    parentGate,
    'telegram-user',
    { sessionId: 'telegram:dm:1#main' },
  );
  const specialists: string[] = [];
  const r = await agent.run(userText, undefined, {
    onToolEnd: (info) => {
      if (info.specialist) specialists.push(info.specialist);
    },
  });
  return { text: r.text, specialists };
}

beforeEach(() => {
  ran.length = 0;
  questions = [];
  childTools = {};
  faux = createFauxCore({
    provider: 'test-provider',
    models: [{ id: 'test-model' }],
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

const teleApaga = (final: string): Script => ({
  principal: [
    () =>
      fauxAssistantMessage(
        [call('delegate', { specialist: 'tele', task: 'apaga la tele' }, 'p1')],
        {
          stopReason: 'toolUse',
        },
      ),
    () => fauxAssistantMessage(final),
  ],
  tele: [
    () =>
      fauxAssistantMessage([call('tv', { action: 'power', state: 'off' }, 't1')], {
        stopReason: 'toolUse',
      }),
    () => fauxAssistantMessage('Tele apagada.'),
  ],
});

describe('agentes-e2e: aprobaciones que llegan tarde o se repiten', () => {
  it('un «sí» que llega después del tope del subagente no ejecuta nada', async () => {
    let late: Promise<void> | undefined;
    const out = await principal(
      'apaga la tele',
      teleApaga('No llegué a tiempo.'),
      (q) => {
        // Nico contesta «sí» tarde: el hijo ya se cortó por tiempo.
        const answer = new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 400));
        late = answer.then(() => undefined);
        void q;
        return answer;
      },
      { timeoutMs: 150 },
    );
    await late;
    await new Promise((r) => setTimeout(r, 100));
    expect(questions).toHaveLength(1);
    expect(ran).toEqual([]);
    expect(out.text).toBe('No llegué a tiempo.');
  });

  it('un «sí» vale para esa acción: la siguiente delegación vuelve a preguntar', async () => {
    const script: Script = {
      principal: [
        () =>
          fauxAssistantMessage(
            [call('delegate', { specialist: 'tv', task: 'apaga la tele' }, 'p1')],
            {
              stopReason: 'toolUse',
            },
          ),
        () =>
          fauxAssistantMessage(
            [call('delegate', { specialist: 'tv', task: 'apágala otra vez' }, 'p2')],
            {
              stopReason: 'toolUse',
            },
          ),
        () => fauxAssistantMessage('Hecho dos veces.'),
      ],
      tv: [
        () =>
          fauxAssistantMessage([call('tv', { action: 'power', state: 'off' }, 't1')], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('Apagada.'),
      ],
    };
    // whoIs lee «Eres el especialista de la tele» → «tele»; el guion es el mismo.
    script.tele = script.tv as Array<() => AssistantMessage>;
    const out = await principal('apaga la tele dos veces', script, 'si');
    expect(questions).toHaveLength(2);
    expect(ran).toEqual([
      { name: 'tv', action: 'power' },
      { name: 'tv', action: 'power' },
    ]);
    expect(out.text).toBe('Hecho dos veces.');
  });

  it('el especialista no puede usar una herramienta fuera de su lista ni preguntando', async () => {
    const script: Script = {
      principal: [
        () =>
          fauxAssistantMessage(
            [call('delegate', { specialist: 'tele', task: 'apaga la tele' }, 'p1')],
            {
              stopReason: 'toolUse',
            },
          ),
        () => fauxAssistantMessage('Listo.'),
      ],
      tele: [
        () =>
          fauxAssistantMessage(
            [
              call('shell', { command: 'shutdown /s' }, 's1'),
              call('casa', { action: 'apagar', entity: 'switch.tv' }, 's2'),
            ],
            { stopReason: 'toolUse' },
          ),
        () => fauxAssistantMessage('No puedo con eso.'),
      ],
    };
    await principal('apaga la tele', script, 'si');
    expect(ran).toEqual([]);
    expect(questions).toEqual([]);
  });

  it('tres delegaciones a la vez con tope 2: las tres terminan y cada una pregunta lo suyo', async () => {
    const script: Script = {
      principal: [
        () =>
          fauxAssistantMessage(
            [
              call('delegate', { specialist: 'tele', task: 'apaga la tele' }, 'p1'),
              call('delegate', { specialist: 'casa', task: 'apaga las luces' }, 'p2'),
              call('delegate', { specialist: 'correo', task: 'mira el correo' }, 'p3'),
            ],
            { stopReason: 'toolUse' },
          ),
        () => fauxAssistantMessage('Todo hecho.'),
      ],
      tele: [
        () =>
          fauxAssistantMessage([call('tv', { action: 'power', state: 'off' }, 't1')], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('Tele apagada.'),
      ],
      casa: [
        () =>
          fauxAssistantMessage([call('casa', { action: 'apagar', entity: 'light.salon' }, 'h1')], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('Luces apagadas.'),
      ],
      correo: [
        () =>
          fauxAssistantMessage([call('correo', { action: 'buscar', texto: 'is:unread' }, 'c1')], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('Nada nuevo.'),
      ],
    };
    const out = await principal('apaga todo y mira el correo', script, 'si', { maxConcurrent: 2 });
    expect(out.text).toBe('Todo hecho.');
    expect([...ran].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'casa', action: 'apagar' },
      { name: 'correo', action: 'buscar' },
      { name: 'tv', action: 'power' },
    ]);
    expect(questions).toHaveLength(2);
    expect([...out.specialists].sort()).toEqual(['correo', 'hogar', 'tv']);
  });
});
