import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * El especialista de notas mira la agenda (asis-expertos-3, PR 2): solo lectura, sin
 * preguntar, y es la MISMA herramienta del hilo (que solo responde en el privado del
 * dueño). Lo demás sigue igual: lo que cambia algo se pregunta y otros especialistas
 * no ven la agenda. PersonalAgent y Gate reales con modelo simulado: sin red.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-expertos3-agenda-'));
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
  'agenda',
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

describe('notas mira la agenda (solo lectura)', () => {
  it('la agenda está en sus herramientas, sin acciones que recortar', () => {
    const notas = resolveSpecialist('notas') as SpecialistSpec;
    expect(notas.tools).toContain('agenda');
    expect(notas.actions?.agenda).toBeUndefined();
    // Los demás especialistas con efectos no la reciben.
    for (const name of ['pc', 'tv', 'hogar'])
      expect((resolveSpecialist(name) as SpecialistSpec).tools).not.toContain('agenda');
  });

  it('mirar la agenda no pregunta y llega la misma herramienta del hilo', async () => {
    const { forThread } = wiring();
    faux.setResponses([
      () =>
        calls(
          ['agenda', { days: 7 }],
          ['reminder', { action: 'create', text: 'dentista', in_minutes: 60 }],
        ),
      () => fauxAssistantMessage('Visto; el recordatorio te lo pregunto.'),
    ]);
    await delegateText(
      forThread(() => THREAD, approver(false)),
      { task: 'mira mi agenda y recuérdame el dentista', specialist: 'notas' },
    );
    expect(seenTools[0]?.map((t) => t.name)).toEqual(['memory', 'reminder', 'agenda']);
    const agenda = seenTools[0]?.find((t) => t.name === 'agenda') as AgentTool;
    const orig = THREAD.find((t) => t.name === 'agenda') as AgentTool;
    expect(agenda.description).toBe(orig.description);
    expect(agenda.parameters).toBe(orig.parameters);
    // La agenda se lee sin preguntar; el recordatorio se pregunta y, con un no, no se crea.
    expect(ran).toEqual([{ name: 'agenda', action: undefined }]);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.startsWith('Especialista Notas:')).toBe(true);
  });

  it('la Gate del especialista deja la agenda libre solo porque el hilo también', async () => {
    const threadGate = createDaemonGate({
      threadKey: 'telegram:dm:1#main',
      dbPath: join(stateDir, 'aprobaciones-hilo-agenda.db'),
      ask: async () => ({ approved: false, scope: 'once' }) as never,
    });
    let asked = 0;
    const child = createEffectfulChildGate(
      {},
      resolveSpecialist('notas') as SpecialistSpec,
      async () => {
        asked++;
        return false;
      },
    );
    for (const args of [{}, { days: 3 }]) {
      const c = await child.check('s-notas', { tool: 'agenda', args, actor: 'subagent' });
      const t = await threadGate.check('t', { tool: 'agenda', args, actor: 'telegram-user' });
      expect([c.verdict, t.verdict, asked]).toEqual(['allow', 'allow', 0]);
    }
    // La Tele no tiene agenda: fuera, sin preguntar.
    const tv = createEffectfulChildGate({}, resolveSpecialist('tv') as SpecialistSpec, async () => {
      asked++;
      return true;
    });
    expect((await tv.check('s-tv', { tool: 'agenda', args: {}, actor: 'subagent' })).verdict).toBe(
      'deny',
    );
    expect(asked).toBe(0);
  });
});
