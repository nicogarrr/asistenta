import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * Especialista de notas y recordatorios (asis-expertos-2, PR 1). `memory` y
 * `reminder` estan en la lista de herramientas prohibidas para hijos; el
 * especialista solo las recibe por el camino con efectos de pc/tv/hogar: hace
 * falta un canal para preguntar, lo que guarda, borra o programa se pregunta
 * accion por accion con su nombre, no hereda nada y nunca toca el perfil.
 * PersonalAgent y Gate reales con modelo simulado: sin red.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-expertos2-notas-'));
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
  'memory',
  'reminder',
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

describe('registro: notas', () => {
  it('alias, efectos y herramientas', () => {
    for (const a of ['notas', 'nota', 'Recordatorios', 'recordatorio', 'memoria', 'apuntes'])
      expect(resolveSpecialist(a)?.name).toBe('notas');
    const notas = resolveSpecialist('notas') as SpecialistSpec;
    expect(notas.effectful).toBe(true);
    expect(notas.tools).toEqual(['memory', 'reminder']);
    expect(resolveSpecialist('agenda')?.name).toBe('calendario');
  });

  it('nunca el perfil ni las conversaciones: solo notas del chat y recordatorios', () => {
    const notas = resolveSpecialist('notas') as SpecialistSpec;
    for (const a of ['save_profile', 'forget_profile', 'profile', 'history', 'suggest_nudge'])
      expect(notas.actions?.memory).not.toContain(a);
    expect([...(notas.actions?.reminder ?? [])].sort()).toEqual(['cancel', 'create', 'list']);
  });
});

describe('notas: sin canal para preguntar no se ejecuta', () => {
  it('la delegate de proceso y la de hilo sin approve lo rechazan sin crear hijo', async () => {
    const w = wiring();
    for (const t of [w.tool, w.forThread(() => THREAD)]) {
      const text = await delegateText(t, {
        task: 'apunta que el lunes viene el fontanero',
        specialist: 'notas',
      });
      expect(text).toMatch(/no tiene forma de pedirte permiso/);
    }
    expect(seenTools).toHaveLength(0);
    expect(ran).toEqual([]);
  });
});

describe('notas: lo que cambia algo se pregunta, con su nombre', () => {
  it('leer no pregunta; crear recordatorio y guardar nota preguntan; perfil y shell ni se preguntan', async () => {
    const { forThread } = wiring();
    faux.setResponses([
      () =>
        calls(
          ['memory', { action: 'recall', query: 'fontanero' }],
          ['reminder', { action: 'list' }],
          ['reminder', { action: 'create', text: 'llamar al fontanero', in_minutes: 60 }],
          ['memory', { action: 'remember', text: 'el fontanero se llama Luis' }],
          ['memory', { action: 'save_profile', text: 'odia los lunes' }],
          ['shell', { command: 'echo hola' }],
        ),
      () => fauxAssistantMessage('Apuntado y recordatorio en una hora.'),
    ]);
    const text = await delegateText(
      forThread(() => THREAD, approver(true)),
      { task: 'apunta lo del fontanero y recuérdamelo en una hora', specialist: 'recordatorios' },
    );
    expect(text).toContain('Apuntado');
    expect(seenTools[0]?.map((t) => t.name)).toEqual(['memory', 'reminder']);
    expect(ran).toEqual([
      { name: 'memory', action: 'recall' },
      { name: 'reminder', action: 'list' },
      { name: 'reminder', action: 'create' },
      { name: 'memory', action: 'remember' },
    ]);
    expect(questions).toHaveLength(2);
    for (const q of questions) expect(q.startsWith('Especialista Notas:')).toBe(true);
    expect(questions[0]).toContain('llamar al fontanero');
  });

  it('no → ni se crea el recordatorio ni se borra la nota', async () => {
    const { forThread } = wiring();
    faux.setResponses([
      () =>
        calls(
          ['reminder', { action: 'create', text: 'x', in_minutes: 5 }],
          ['memory', { action: 'forget', id: 'm1' }],
          ['reminder', { action: 'cancel', text: 'dentista' }],
        ),
      () => fauxAssistantMessage('No lo hago: no me diste permiso.'),
    ]);
    await delegateText(
      forThread(() => THREAD, approver(false)),
      {
        task: 'limpia mis recordatorios',
        specialist: 'notas',
      },
    );
    expect(questions).toHaveLength(3);
    expect(ran).toEqual([]);
  });

  it('dos delegaciones iguales preguntan dos veces: nada se hereda entre hijos', async () => {
    const { forThread } = wiring();
    const delegate = forThread(() => THREAD, approver(true));
    for (let i = 0; i < 2; i++) {
      faux.setResponses([
        () => calls(['reminder', { action: 'create', text: 'pastilla', in_minutes: 30 }]),
        () => fauxAssistantMessage('Hecho.'),
      ]);
      await delegateText(delegate, {
        task: 'recuérdame la pastilla en media hora',
        specialist: 'notas',
      });
    }
    expect(questions).toHaveLength(2);
    expect(ran).toEqual([
      { name: 'reminder', action: 'create' },
      { name: 'reminder', action: 'create' },
    ]);
  });

  it('las herramientas llegan tal cual (nombre, descripcion y parametros)', async () => {
    const { forThread } = wiring();
    faux.setResponses([() => fauxAssistantMessage('nada')]);
    await delegateText(
      forThread(() => THREAD, approver(false)),
      { task: 'mira', specialist: 'notas' },
    );
    for (const t of seenTools[0] ?? []) {
      const orig = THREAD.find((o) => o.name === t.name) as AgentTool;
      expect(t.description).toBe(orig.description);
      expect(t.parameters).toBe(orig.parameters);
    }
  });
});

describe('notas: la Gate del especialista nunca es mas libre que la del hilo', () => {
  const CALLS: Array<{ tool: string; args: Record<string, unknown> }> = [
    { tool: 'memory', args: { action: 'recall', query: 'x' } },
    { tool: 'memory', args: { action: 'list' } },
    { tool: 'memory', args: { action: 'get', id: 'm1' } },
    { tool: 'memory', args: { action: 'timeline' } },
    { tool: 'memory', args: { action: 'remember', text: 'y' } },
    { tool: 'memory', args: { action: 'forget', id: 'm1' } },
    { tool: 'memory', args: { action: 'save_profile', text: 'z' } },
    { tool: 'memory', args: { action: 'history', query: 'q' } },
    { tool: 'reminder', args: { action: 'list' } },
    { tool: 'reminder', args: { action: 'create', text: 'a', in_minutes: 5 } },
    { tool: 'reminder', args: { action: 'cancel', text: 'a' } },
    { tool: 'shell', args: { command: 'dir' } },
  ];

  it('lo que pasa sin preguntar, el hilo tambien lo deja pasar; lo ajeno, fuera', async () => {
    const threadGate = createDaemonGate({
      threadKey: 'telegram:dm:1#main',
      dbPath: join(stateDir, 'aprobaciones-hilo-notas.db'),
      ask: async () => ({ approved: false, scope: 'once' }) as never,
    });
    const spec = resolveSpecialist('notas') as SpecialistSpec;
    let childAsked = 0;
    const child = createEffectfulChildGate({}, spec, async () => {
      childAsked++;
      return false;
    });
    const free: string[] = [];
    for (const call of CALLS) {
      childAsked = 0;
      const c = await child.check('s-notas', { ...call, actor: 'subagent' });
      if (c.verdict === 'allow' && childAsked === 0) {
        free.push(`${call.tool}:${String(call.args.action)}`);
        const t = await threadGate.check('t', { ...call, actor: 'telegram-user' });
        expect({ call, thread: t.verdict }).toEqual({ call, thread: 'allow' });
      }
      if (!spec.tools.includes(call.tool)) expect(c.verdict).toBe('deny');
    }
    expect(free.sort()).toEqual([
      'memory:get',
      'memory:list',
      'memory:recall',
      'memory:timeline',
      'reminder:list',
    ]);
  });
});

describe('notas en la ayuda', () => {
  it('/funciones y la descripcion de delegate lo nombran', async () => {
    const source = readFileSync(new URL('../src/funciones.ts', import.meta.url), 'utf8');
    const line = /text: '(paso tareas largas a especialistas[^']*)'/.exec(source)?.[1] ?? '';
    expect(line).toContain('notas');
    expect(line.length).toBeLessThan(90);
    const { createDelegateTool } = await import('../src/tools/delegate.js');
    const t = createDelegateTool({ run: async () => ({ text: '', depth: 1 }) } as never, () => 0);
    expect(t.description).toMatch(/notas \(/);
  });
});
