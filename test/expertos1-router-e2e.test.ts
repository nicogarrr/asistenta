import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, FauxResponseFactory } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * E2E (asis-expertos-1, PR 4): un modelo simulado hace de agente principal y
 * elige especialista con `delegate`; los hijos corren con PersonalAgent y Gate
 * reales. Antes, el registro de especialistas y su camino de permiso. Solo corren
 * con un canal para preguntar al humano; cada accion con efecto vuelve a
 * preguntar (sin heredar nada del padre), la pregunta nombra al especialista y
 * las herramientas de TV y Computer Use llegan tal cual. PersonalAgent y Gate
 * reales con modelo simulado: sin red, sin tele, sin PC.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-expertos1-4-'));
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

async function principal(userText: string, script: Script): Promise<string> {
  const w = createDelegateWiring({
    config: CONFIG,
    parentTools: () => PROCESS,
    createAgent: (config, tools, gate, actor, opts) => {
      childTools[actor + Object.keys(childTools).length] = tools.map((t) => t.name);
      return PersonalAgent.create(config, tools, gate, actor, opts);
    },
  });
  const delegate = w.forThread(
    () => THREAD,
    async (q) => {
      questions.push(q);
      return true;
    },
  );
  const parentGate = createDaemonGate({
    threadKey: 'telegram:dm:1#main',
    dbPath: join(stateDir, 'aprobaciones-principal.db'),
    ask: async () => ({ approved: false, scope: 'once' }) as never,
  });
  // Muchas respuestas: el factory decide por contexto, no por orden.
  faux.setResponses(Array.from({ length: 40 }, () => play(script)));
  const agent = await PersonalAgent.create(
    CONFIG,
    [delegate, ...THREAD],
    parentGate,
    'telegram-user',
    {
      sessionId: 'telegram:dm:1#main',
    },
  );
  const r = await agent.run(userText);
  return r.text;
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

describe('e2e: el principal elige especialista', () => {
  it('«enciende la tele y pon Netflix»: delega en la tele, que pide permiso en cada paso', async () => {
    const text = await principal('enciende la tele y pon Netflix', {
      principal: [
        () =>
          fauxAssistantMessage(
            [
              call(
                'delegate',
                { specialist: 'tele', task: 'enciende la tele y abre Netflix' },
                'p1',
              ),
            ],
            { stopReason: 'toolUse' },
          ),
        () => fauxAssistantMessage('Listo: la tele está encendida con Netflix.'),
      ],
      tele: [
        () =>
          fauxAssistantMessage(
            [
              call('tv', { action: 'power', state: 'on' }, 't1'),
              call('tv', { action: 'launch', app: 'netflix' }, 't2'),
            ],
            { stopReason: 'toolUse' },
          ),
        () => fauxAssistantMessage('Tele encendida y Netflix abierto.'),
      ],
    });
    expect(text).toContain('Netflix');
    expect(ran).toEqual([
      { name: 'tv', action: 'power' },
      { name: 'tv', action: 'launch' },
    ]);
    expect(questions).toHaveLength(2);
    expect(questions.every((q) => q.startsWith('Especialista Tele:'))).toBe(true);
    expect(Object.values(childTools)).toEqual([['tv']]);
  });

  it('correo y calendario a la vez: dos especialistas de solo lectura, sin preguntar nada', async () => {
    const text = await principal('¿me ha llegado la factura de la luz y qué tengo el jueves?', {
      principal: [
        () =>
          fauxAssistantMessage(
            [
              call('delegate', { specialist: 'correo', task: 'busca la factura de la luz' }, 'p1'),
              call('delegate', { specialist: 'calendario', task: '¿qué tengo el jueves?' }, 'p2'),
            ],
            { stopReason: 'toolUse' },
          ),
        () => fauxAssistantMessage('Sí, llegó la factura; el jueves tienes dentista a las 10.'),
      ],
      correo: [
        () =>
          fauxAssistantMessage(
            [
              call('correo', { action: 'buscar', texto: 'factura luz' }, 'c1'),
              call('correo', { action: 'nuevo', para: ['x@y.z'], asunto: 'x', cuerpo: 'x' }, 'c2'),
            ],
            { stopReason: 'toolUse' },
          ),
        () => fauxAssistantMessage('Llegó la factura de la luz el día 28.'),
      ],
      calendario: [
        () =>
          fauxAssistantMessage([call('calendar', { action: 'agenda', days: 7 }, 'k1')], {
            stopReason: 'toolUse',
          }),
        () => fauxAssistantMessage('Jueves: dentista a las 10:00.'),
      ],
    });
    expect(text).toContain('dentista');
    expect(ran).toEqual(
      expect.arrayContaining([
        { name: 'correo', action: 'buscar' },
        { name: 'calendar', action: 'agenda' },
      ]),
    );
    expect(ran).toHaveLength(2);
    expect(questions).toEqual([]);
    expect(Object.values(childTools).map((t) => [...t].sort())).toEqual(
      expect.arrayContaining([['correo'], ['calendar', 'festivos']]),
    );
  });

  it('especialista que no existe: lo hace el subagente generico, solo lectura', async () => {
    await principal('mira esto por mí', {
      principal: [
        () =>
          fauxAssistantMessage(
            [call('delegate', { specialist: 'astrologo', task: 'mira' }, 'p1')],
            {
              stopReason: 'toolUse',
            },
          ),
        () => fauxAssistantMessage('Hecho.'),
      ],
      generico: [
        () =>
          fauxAssistantMessage([call('tv', { action: 'power' }, 'g1')], { stopReason: 'toolUse' }),
        () => fauxAssistantMessage('Nada que hacer.'),
      ],
    });
    expect(ran).toEqual([]);
    expect(questions).toEqual([]);
    expect(Object.values(childTools)[0]?.sort()).toEqual(['fetch', 'list', 'read', 'web']);
  });
});

describe('la pista para elegir vive fuera del prompt principal', () => {
  it('cargar_herramienta anuncia los especialistas y «especialista» carga delegate', async () => {
    const { deferredSpecs } = await import('../src/core/capabilities.js');
    const spec = deferredSpecs().delegate;
    expect(spec?.purpose).toMatch(/especialista \(correo, calendario, notas, web, pc, tv, hogar\)/);
    expect(spec?.pattern.test('pídeselo al especialista de la tele')).toBe(true);
    const { SYSTEM_PROMPT } = await import('../src/core/prompt.js');
    expect(SYSTEM_PROMPT.length).toBeLessThan(9_700);
  });

  it('/funciones cuenta lo de los especialistas en Investigar, sin pasarse de largo', async () => {
    const { TOOL_ABILITIES } = await import('../src/funciones.js');
    const d = TOOL_ABILITIES.delegate;
    expect(d?.area).toBe('investigar');
    expect(d?.text).toMatch(/especialistas: correo, calendario, notas, web, PC, tele y casa/);
    expect(Array.from(d?.text ?? '').length).toBeLessThan(90);
  });
});
