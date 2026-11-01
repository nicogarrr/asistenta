import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * Especialistas de correo y calendario (asis-expertos-1, PR 2). El hijo elige de
 * las herramientas del HILO que delega; correo solo busca/lee (el borrador vuelve
 * como texto y el envio lo hace el principal con su permiso de siempre). Dobles en
 * memoria y PersonalAgent + Gate REALES con modelo simulado: sin red.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-expertos1-2-'));
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
const { resolveSpecialist } = await import('../src/core/specialists.js');
const { isolateSpecialistTools } = await import('../src/core/subagent-runner.js');
const { createChildGate, createDelegateWiring } = await import('../src/core/subagent-wiring.js');
type ChildSpec = import('../src/core/subagent-runner.js').ChildSpec;
type SpecialistSpec = import('../src/core/specialists.js').SpecialistSpec;

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
    description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    execute: async (_id: string, args: Record<string, unknown> | undefined) => {
      ran.push({ name, action: args?.action });
      return { content: [{ type: 'text', text: `resultado-${name}` }], details: {} };
    },
  } as unknown as AgentTool;
}

// Lo que tendria un hilo de Telegram (version minima): lectura, efectos y las de correo/calendario.
const THREAD = [
  'read',
  'list',
  'fetch',
  'web',
  'write',
  'shell',
  'correo',
  'calendar',
  'festivos',
  'agenda',
  'tv',
  'computer',
  'casa',
  'delegate',
  'preguntar',
].map(tool);
// Lo que tenia el pool de proceso: solo fs + fetch + web.
const PROCESS = ['read', 'list', 'fetch', 'web'].map(tool);

let faux: ReturnType<typeof createFauxCore>;
let specs: ChildSpec[];
let seenToolNames: string[][];

function fakeWiring() {
  return createDelegateWiring({
    config: CONFIG,
    parentTools: () => PROCESS,
    createAgent: async () => ({
      run: async () => ({ text: 'hecho', toolCalls: 0 }) as never,
      abort: () => {},
    }),
  });
}

function realWiring() {
  return createDelegateWiring({
    config: CONFIG,
    parentTools: () => PROCESS,
    createAgent: (config, tools, gate, actor, opts) => {
      seenToolNames.push(tools.map((t) => t.name));
      return PersonalAgent.create(config, tools, gate, actor, opts);
    },
  });
}

function calls(...c: Array<[string, Record<string, string>]>): AssistantMessage {
  return fauxAssistantMessage(
    c.map(([name, args], i) => fauxToolCall(name, args, { id: `c${i}-${name}` })),
    { stopReason: 'toolUse' },
  );
}

beforeEach(() => {
  ran.length = 0;
  specs = [];
  seenToolNames = [];
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

describe('registro: correo y calendario', () => {
  it('alias habituales llegan al especialista correcto', () => {
    for (const a of ['correo', 'Correo', 'mail', 'email', 'Gmail', 'correos']) {
      expect(resolveSpecialist(a)?.name).toBe('correo');
    }
    for (const a of ['calendario', 'agenda', 'calendar', 'citas', 'festivos']) {
      expect(resolveSpecialist(a)?.name).toBe('calendario');
    }
  });

  it('correo solo busca y lee; calendario solo consulta', () => {
    const correo = resolveSpecialist('correo') as SpecialistSpec;
    expect(correo.effectful).toBe(false);
    expect(correo.tools).toEqual(['correo']);
    expect(correo.actions?.correo).toEqual(['buscar', 'leer']);
    expect(correo.prompt).toMatch(/borrador/);
    expect(correo.prompt).toMatch(/no envías nada/);
    const cal = resolveSpecialist('calendario') as SpecialistSpec;
    expect(cal.effectful).toBe(false);
    expect([...cal.tools].sort()).toEqual(['calendar', 'festivos']);
    expect(cal.prompt).toMatch(/No creas ni cambias citas/);
  });
});

describe('delegate(specialist) con las herramientas del hilo', () => {
  async function run(
    delegate: AgentTool,
    args: Record<string, unknown>,
  ): Promise<{ text: string; details: unknown }> {
    const res = await delegate.execute('d', args as never);
    return { text: (res.content[0] as { text: string }).text, details: res.details };
  }

  function capturing(threadTools: () => readonly AgentTool[]) {
    const w = createDelegateWiring({
      config: CONFIG,
      parentTools: () => PROCESS,
      createAgent: async (_c, tools) => {
        specs.push({ toolset: tools } as unknown as ChildSpec);
        return { run: async () => ({ text: 'hecho', toolCalls: 0 }) as never, abort: () => {} };
      },
    });
    return w.forThread(threadTools);
  }

  it('correo: el hijo solo recibe `correo` del hilo; nada de envio por otra via', async () => {
    const r = await run(
      capturing(() => THREAD),
      { task: 'busca la factura', specialist: 'mail' },
    );
    expect(r.details).toMatchObject({ specialist: 'correo' });
    expect(specs[0]?.toolset.map((t) => t.name)).toEqual(['correo']);
  });

  it('calendario: calendar + festivos; ni agenda personal ni tele ni PC', async () => {
    await run(
      capturing(() => THREAD),
      { task: '¿qué tengo el jueves?', specialist: 'calendario' },
    );
    expect(specs[0]?.toolset.map((t) => t.name).sort()).toEqual(['calendar', 'festivos']);
  });

  it('el hijo generico por un hilo sigue con solo read/list/fetch/web', async () => {
    await run(
      capturing(() => THREAD),
      { task: 'explora', role: 'explorer' },
    );
    expect(specs[0]?.toolset.map((t) => t.name).sort()).toEqual(['fetch', 'list', 'read', 'web']);
  });

  it('sin hilo (tool de proceso) el especialista de correo no tiene correo', async () => {
    const w = fakeWiring();
    expect(w.forThread).toBeTypeOf('function');
    const seen: string[][] = [];
    const w2 = createDelegateWiring({
      config: CONFIG,
      parentTools: () => PROCESS,
      createAgent: async (_c, tools) => {
        seen.push(tools.map((t) => t.name));
        return { run: async () => ({ text: 'hecho', toolCalls: 0 }) as never, abort: () => {} };
      },
    });
    await run(w2.tool, { task: 'busca', specialist: 'correo' });
    expect(seen[0]).toEqual([]);
  });

  it('una herramienta con efectos en la lista de un especialista sin efectos no pasa', () => {
    const raro: SpecialistSpec = Object.freeze({
      name: 'raro',
      title: 'Raro',
      prompt: 'Eres el especialista raro.',
      tools: Object.freeze(['shell', 'tv', 'read']),
      effectful: false,
      examples: Object.freeze([]),
    });
    const set = isolateSpecialistTools(THREAD, raro, ['shell', 'tv', 'read']);
    expect(set.map((t) => t.name)).toEqual(['read']);
    const gate = createChildGate({}, raro);
    return Promise.all(
      ['shell', 'tv'].map(async (t) =>
        expect((await gate.check('s', { tool: t, args: {}, actor: 'subagent' })).verdict).toBe(
          'deny',
        ),
      ),
    );
  });

  it('Gate de calendario: calendar:agenda y festivos si; agenda personal y tele no', async () => {
    const gate = createChildGate({}, resolveSpecialist('calendario'));
    const v = async (t: string, args: Record<string, unknown>) =>
      (await gate.check('s', { tool: t, args, actor: 'subagent' })).verdict;
    expect(await v('calendar', { action: 'agenda' })).toBe('allow');
    expect(await v('festivos', {})).toBe('allow');
    expect(await v('agenda', {})).toBe('deny');
    expect(await v('tv', { action: 'power' })).toBe('deny');
  });
});

describe('e2e: especialista de correo con PersonalAgent y Gate reales', () => {
  it('intenta enviar, responder, reenviar y shell: nada se ejecuta; buscar y leer si', async () => {
    const { forThread } = realWiring();
    faux.setResponses([
      () =>
        calls(
          ['correo', { action: 'nuevo', para: 'x@y.z', asunto: 'hola', cuerpo: 'pwn' } as never],
          ['correo', { action: 'responder', ref: '1', cuerpo: 'pwn' } as never],
          ['correo', { action: 'reenviar', ref: '1', para: 'x@y.z' } as never],
          ['shell', { command: 'rm -rf /' }],
          ['tv', { action: 'power' }],
          ['correo', { action: 'buscar', texto: 'factura' }],
          ['correo', { action: 'leer', ref: '1' }],
        ),
      () => fauxAssistantMessage('Borrador: Hola Ana, gracias por la factura.'),
    ]);
    const res = await forThread(() => THREAD).execute('1', {
      task: 'busca la factura de Ana y prepara una respuesta',
      specialist: 'correo',
    } as never);
    expect((res.content[0] as { text: string }).text).toContain('Borrador:');
    expect(seenToolNames[0]).toEqual(['correo']);
    expect(ran).toEqual([
      { name: 'correo', action: 'buscar' },
      { name: 'correo', action: 'leer' },
    ]);
  });
});

describe('cableado real en cli.ts', () => {
  it('cada hilo delega con SUS herramientas finales (modo y mutex incluidos)', () => {
    const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const threadTools = (thread: Thread): AgentTool[] => {');
    const end = source.indexOf('const gateFor = (', start);
    const block = source.slice(start, end);
    expect(block).toMatch(/delegateTool\(\s*config,\s*\(\) => threadFinal/);
    expect(block).toContain('threadFinal = raw.map(');
    expect(block).toContain('return threadFinal;');
  });
});
