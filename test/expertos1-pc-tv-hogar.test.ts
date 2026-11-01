import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * Especialistas con efectos: pc, tv y hogar (asis-expertos-1, PR 3). Solo corren
 * con un canal para preguntar al humano; cada accion con efecto vuelve a
 * preguntar (sin heredar nada del padre), la pregunta nombra al especialista y
 * las herramientas de TV y Computer Use llegan tal cual. PersonalAgent y Gate
 * reales con modelo simulado: sin red, sin tele, sin PC.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-expertos1-3-'));
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
const { createDelegateWiring, createEffectfulChildGate } = await import(
  '../src/core/subagent-wiring.js'
);
const { createDaemonGate } = await import('../src/daemon/gate.js');
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
  'write',
  'shell',
  'correo',
  'calendar',
  'tv',
  'computer',
  'windows',
  'casa',
  'delegate',
  'preguntar',
].map(tool);
const PROCESS = ['read', 'list', 'fetch', 'web'].map(tool);

let faux: ReturnType<typeof createFauxCore>;
let seenTools: AgentTool[][];
let questions: string[];

function wiring() {
  return createDelegateWiring({
    config: CONFIG,
    parentTools: () => PROCESS,
    createAgent: (config, tools, gate, actor, opts) => {
      seenTools.push(tools);
      return PersonalAgent.create(config, tools, gate, actor, opts);
    },
  });
}

function approver(answer: boolean) {
  return async (q: string) => {
    questions.push(q);
    return answer;
  };
}

function calls(...c: Array<[string, Record<string, unknown>]>): AssistantMessage {
  return fauxAssistantMessage(
    c.map(([name, args], i) => fauxToolCall(name, args as never, { id: `c${i}-${name}` })),
    { stopReason: 'toolUse' },
  );
}

async function delegateText(t: AgentTool, args: Record<string, unknown>): Promise<string> {
  const res = await t.execute('d', args as never);
  return (res.content[0] as { text: string }).text;
}

beforeEach(() => {
  ran.length = 0;
  seenTools = [];
  questions = [];
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

describe('registro: pc, tv y hogar', () => {
  it('alias y marca de efectos', () => {
    for (const a of ['pc', 'ordenador', 'Windows', 'pantalla'])
      expect(resolveSpecialist(a)?.name).toBe('pc');
    for (const a of ['tv', 'tele', 'televisión', 'SmartTV'])
      expect(resolveSpecialist(a)?.name).toBe('tv');
    for (const a of ['hogar', 'casa', 'Home Assistant'.replace(' ', ''), 'luces', 'domótica'])
      expect(resolveSpecialist(a)?.name).toBe('hogar');
    for (const n of ['pc', 'tv', 'hogar']) expect(resolveSpecialist(n)?.effectful).toBe(true);
    for (const n of ['web', 'correo', 'calendario'])
      expect(resolveSpecialist(n)?.effectful).toBe(false);
  });

  it('pc sin batch; tv solo los mandos de siempre (sin comandos crudos ni URLs)', () => {
    const pc = resolveSpecialist('pc') as SpecialistSpec;
    expect(pc.actions?.computer).not.toContain('batch');
    const tv = resolveSpecialist('tv') as SpecialistSpec;
    expect(tv.tools).toEqual(['tv']);
    for (const a of ['power', 'volume', 'mute', 'input', 'launch', 'apps', 'media'])
      expect(tv.actions?.tv).toContain(a);
    for (const a of ['command', 'url', 'inspect', 'adblock'])
      expect(tv.actions?.tv).not.toContain(a);
  });
});

describe('sin canal para preguntar no se ejecuta', () => {
  it('la delegate de proceso y la de hilo sin approve rechazan pc/tv/hogar sin crear hijo', async () => {
    const w = wiring();
    for (const t of [w.tool, w.forThread(() => THREAD)]) {
      for (const s of ['pc', 'tele', 'casa']) {
        const text = await delegateText(t, { task: 'enciende', specialist: s });
        expect(text).toMatch(/no tiene forma de pedirte permiso/);
      }
    }
    expect(seenTools).toHaveLength(0);
    expect(ran).toEqual([]);
  });
});

describe('con canal: cada accion vuelve a preguntar y la pregunta nombra al especialista', () => {
  it('tv: si → se ejecuta; cada accion pregunta otra vez; command y shell ni se preguntan', async () => {
    const { forThread } = wiring();
    faux.setResponses([
      () =>
        calls(
          ['tv', { action: 'power', state: 'on' }],
          ['tv', { action: 'volume', level: 15 }],
          ['tv', { action: 'command', uri: 'ssap://system/turnOff' }],
          ['shell', { command: 'echo hola' }],
        ),
      () => fauxAssistantMessage('Tele encendida y volumen a 15.'),
    ]);
    const text = await delegateText(
      forThread(() => THREAD, approver(true)),
      {
        task: 'enciende la tele y pon el volumen a 15',
        specialist: 'tele',
      },
    );
    expect(text).toContain('Tele encendida');
    expect(seenTools[0]?.map((t) => t.name)).toEqual(['tv']);
    expect(ran).toEqual([
      { name: 'tv', action: 'power' },
      { name: 'tv', action: 'volume' },
    ]);
    expect(questions).toHaveLength(2);
    for (const q of questions) expect(q.startsWith('Especialista Tele:')).toBe(true);
  });

  it('tv: no → no se ejecuta nada', async () => {
    const { forThread } = wiring();
    faux.setResponses([
      () => calls(['tv', { action: 'power', state: 'off' }]),
      () => fauxAssistantMessage('No la apago: no me diste permiso.'),
    ]);
    await delegateText(
      forThread(() => THREAD, approver(false)),
      {
        task: 'apaga la tele',
        specialist: 'tv',
      },
    );
    expect(questions).toHaveLength(1);
    expect(ran).toEqual([]);
  });

  it('dos delegaciones iguales preguntan dos veces: nada se hereda entre hijos', async () => {
    const { forThread } = wiring();
    const delegate = forThread(() => THREAD, approver(true));
    for (let i = 0; i < 2; i++) {
      faux.setResponses([
        () => calls(['casa', { action: 'encender', entidad: 'light.salon' }]),
        () => fauxAssistantMessage('Hecho.'),
      ]);
      await delegateText(delegate, { task: 'enciende la luz del salón', specialist: 'hogar' });
    }
    expect(questions).toHaveLength(2);
    for (const q of questions) expect(q.startsWith('Especialista Casa:')).toBe(true);
    expect(ran).toEqual([
      { name: 'casa', action: 'encender' },
      { name: 'casa', action: 'encender' },
    ]);
  });

  it('pc: batch nunca corre (sus pasos irían por la Gate del hilo); click pregunta', async () => {
    const { forThread } = wiring();
    faux.setResponses([
      () =>
        calls(
          ['computer', { action: 'batch', actions: [{ action: 'click', x: 1, y: 1 }] }],
          ['computer', { action: 'click', x: 10, y: 20 }],
          ['tv', { action: 'power' }],
        ),
      () => fauxAssistantMessage('Hecho.'),
    ]);
    await delegateText(
      forThread(() => THREAD, approver(true)),
      {
        task: 'haz clic en Aceptar',
        specialist: 'pc',
      },
    );
    expect(seenTools[0]?.map((t) => t.name).sort()).toEqual([
      'computer',
      'list',
      'read',
      'windows',
    ]);
    expect(ran).toEqual([{ name: 'computer', action: 'click' }]);
    expect(questions.every((q) => q.startsWith('Especialista PC:'))).toBe(true);
  });

  it('las herramientas de TV y Computer Use llegan tal cual (nombre, descripcion y parametros)', async () => {
    const { forThread } = wiring();
    for (const s of ['tv', 'pc']) {
      faux.setResponses([() => fauxAssistantMessage('nada')]);
      await delegateText(
        forThread(() => THREAD, approver(false)),
        { task: 'mira', specialist: s },
      );
    }
    for (const set of seenTools) {
      for (const t of set) {
        const orig = THREAD.find((o) => o.name === t.name) as AgentTool;
        expect(t.description).toBe(orig.description);
        expect(t.parameters).toBe(orig.parameters);
        expect(t.label).toBe(orig.label);
      }
    }
  });
});

describe('la Gate del especialista nunca es mas libre que la del hilo', () => {
  const CALLS: Array<{ tool: string; args: Record<string, unknown> }> = [
    { tool: 'tv', args: { action: 'power' } },
    { tool: 'tv', args: { action: 'volume', level: 10 } },
    { tool: 'tv', args: { action: 'status' } },
    { tool: 'tv', args: { action: 'command', uri: 'x' } },
    { tool: 'casa', args: { action: 'estado' } },
    { tool: 'casa', args: { action: 'apagar', entidad: 'light.salon' } },
    { tool: 'computer', args: { action: 'screenshot' } },
    { tool: 'computer', args: { action: 'click', x: 1, y: 1 } },
    { tool: 'computer', args: { action: 'type', text: 'hola' } },
    { tool: 'windows', args: { action: 'focus', title: 'Excel' } },
    { tool: 'windows', args: { action: 'list' } },
    { tool: 'shell', args: { command: 'dir' } },
    { tool: 'write', args: { path: 'x.txt', content: 'y' } },
  ];

  it('lo que el especialista deja pasar sin preguntar, el hilo tambien', async () => {
    let threadAsked = 0;
    const threadGate = createDaemonGate({
      threadKey: 'telegram:dm:1#main',
      dbPath: join(stateDir, 'aprobaciones-hilo.db'),
      ask: async () => {
        threadAsked++;
        return { approved: false, scope: 'once' } as never;
      },
    });
    for (const name of ['pc', 'tv', 'hogar']) {
      const spec = resolveSpecialist(name) as SpecialistSpec;
      let childAsked = 0;
      const child = createEffectfulChildGate({}, spec, async () => {
        childAsked++;
        return false;
      });
      for (const call of CALLS) {
        childAsked = 0;
        threadAsked = 0;
        const c = await child.check(`s-${name}`, { ...call, actor: 'subagent' });
        const t = await threadGate.check('t', { ...call, actor: 'telegram-user' });
        if (c.verdict === 'allow' && childAsked === 0) {
          expect({ name, call, thread: t.verdict, threadAsked }).toEqual({
            name,
            call,
            thread: 'allow',
            threadAsked: 0,
          });
        }
        // Lo que no es suyo, fuera siempre.
        if (!spec.tools.includes(call.tool)) expect(c.verdict).toBe('deny');
      }
    }
  });
});

describe('cableado real en cli.ts', () => {
  it('el hilo pasa su chat para preguntar, sin botones de «Siempre»', () => {
    const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const threadTools = (thread: Thread): AgentTool[] => {');
    const block = source.slice(start, source.indexOf('const gateFor = (', start));
    expect(block).toMatch(
      /delegateTool\(\s*config,\s*\(\) => threadFinal,\s*\(question\) => askOncePerTurn\(thread, question\),?\s*\)/,
    );
  });
});
