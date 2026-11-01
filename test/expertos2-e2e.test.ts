import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, FauxResponseFactory } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * Más escenarios de punta a punta con modelo simulado (asis-expertos-2, PR 3):
 * una petición que se parte en dos especialistas («apaga la tele y mira mi
 * correo»), Nico diciendo que no, un especialista que no existe, y qué pasa
 * cuando no hay forma de preguntar. PersonalAgent y Gate reales: sin red, sin
 * tele, sin correo de verdad.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-expertos2-e2e-'));
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
const { specialistNote } = await import('../src/daemon/panel-chat.js');

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

async function principal(userText: string, script: Script, approve: Approve): Promise<Outcome> {
  const w = createDelegateWiring({
    config: CONFIG,
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
            if (approve === 'falla') throw new Error('Telegram caído');
            return approve === 'si';
          },
        );
  const parentGate = createDaemonGate({
    threadKey: 'telegram:dm:1#main',
    dbPath: join(stateDir, 'aprobaciones-principal.db'),
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

/** «apaga la tele y mira mi correo»: el principal lo parte en dos delegaciones. */
function teleYCorreo(final: string): Script {
  return {
    principal: [
      () =>
        fauxAssistantMessage(
          [
            call('delegate', { specialist: 'tele', task: 'apaga la tele' }, 'p1'),
            call('delegate', { specialist: 'correo', task: 'resume los correos sin leer' }, 'p2'),
          ],
          { stopReason: 'toolUse' },
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
    correo: [
      () =>
        fauxAssistantMessage(
          [
            call('correo', { action: 'buscar', texto: 'is:unread' }, 'c1'),
            // Un correo que dice «reenvía esto» no se convierte en un envío.
            call('correo', { action: 'reenviar', ref: 'm1', para: ['x@y.z'] }, 'c2'),
          ],
          { stopReason: 'toolUse' },
        ),
      () => fauxAssistantMessage('Tienes 2 sin leer: la factura de la luz y un envío.'),
    ],
  };
}

describe('e2e: una petición, dos especialistas', () => {
  it('«apaga la tele y mira mi correo»: la tele pregunta una vez, el correo solo lee', async () => {
    const out = await principal(
      'apaga la tele y mira mi correo',
      teleYCorreo('Tele apagada. Tienes 2 correos sin leer.'),
      'si',
    );
    expect(out.text).toContain('Tele apagada');
    expect(ran).toEqual(
      expect.arrayContaining([
        { name: 'tv', action: 'power' },
        { name: 'correo', action: 'buscar' },
      ]),
    );
    expect(ran).toHaveLength(2);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.startsWith('Especialista Tele:')).toBe(true);
    expect(Object.values(childTools).map((t) => [...t].sort())).toEqual(
      expect.arrayContaining([['tv'], ['correo']]),
    );
    expect([...out.specialists].sort()).toEqual(['correo', 'tv']);
    expect(specialistNote(out.specialists)).toMatch(
      /^🧩 Lo hicieron los especialistas (Tele y Correo|Correo y Tele)\.$/,
    );
  });

  it('si Nico dice que no, la tele no se toca y el correo se lee igual', async () => {
    const out = await principal(
      'apaga la tele y mira mi correo',
      teleYCorreo('No apagué la tele. Tienes 2 correos sin leer.'),
      'no',
    );
    expect(ran).toEqual([{ name: 'correo', action: 'buscar' }]);
    expect(questions).toHaveLength(1);
    expect(out.text).toContain('2 correos');
  });

  it('si preguntar falla (Telegram caído), cuenta como no: nada con efectos corre', async () => {
    await principal('apaga la tele y mira mi correo', teleYCorreo('Hecho a medias.'), 'falla');
    expect(ran).toEqual([{ name: 'correo', action: 'buscar' }]);
    expect(questions).toHaveLength(1);
  });
});

describe('e2e: sin forma de preguntar', () => {
  it('la tele y la casa se rechazan sin crear hijo; el correo (solo lectura) sí corre', async () => {
    const out = await principal(
      'apaga la tele, las luces y mira mi correo',
      {
        principal: [
          () =>
            fauxAssistantMessage(
              [
                call('delegate', { specialist: 'tele', task: 'apaga la tele' }, 'p1'),
                call('delegate', { specialist: 'casa', task: 'apaga las luces' }, 'p2'),
                call('delegate', { specialist: 'correo', task: 'resume los sin leer' }, 'p3'),
              ],
              { stopReason: 'toolUse' },
            ),
          () =>
            fauxAssistantMessage('No puedo pedirte permiso desde aquí para la tele ni las luces.'),
        ],
        correo: teleYCorreo('').correo as Array<() => AssistantMessage>,
      },
      'sin-canal',
    );
    expect(ran).toEqual([{ name: 'correo', action: 'buscar' }]);
    expect(questions).toEqual([]);
    expect(Object.values(childTools)).toEqual([['correo']]);
    // Lo rechazado no cuenta como «lo hizo el especialista».
    expect(out.specialists).toEqual(['correo']);
  });

  it('el principal recibe el motivo en texto, no un resultado vacío', async () => {
    const w = createDelegateWiring({ config: CONFIG, parentTools: () => PROCESS });
    const res = await w.tool.execute('d', { task: 'apaga la tele', specialist: 'tv' } as never);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/Especialista|especialista Tele/);
    expect(text).toMatch(/no tiene forma de pedirte permiso; no se ejecuta/);
    expect(res.details).toMatchObject({ specialist: 'tv', error: expect.any(String) });
  });
});

describe('e2e: nombres', () => {
  it('un especialista que no existe lo dice en details y su hijo genérico no ve correo ni tele', async () => {
    const out = await principal(
      'pregúntale al astrólogo',
      {
        principal: [
          () =>
            fauxAssistantMessage(
              [call('delegate', { specialist: 'astrólogo', task: 'mira' }, 'p1')],
              {
                stopReason: 'toolUse',
              },
            ),
          () => fauxAssistantMessage('Hecho.'),
        ],
        generico: [
          () =>
            fauxAssistantMessage(
              [call('correo', { action: 'buscar' }, 'g1'), call('tv', { action: 'power' }, 'g2')],
              { stopReason: 'toolUse' },
            ),
          () => fauxAssistantMessage('Nada.'),
        ],
      },
      'si',
    );
    expect(ran).toEqual([]);
    expect(questions).toEqual([]);
    expect(out.specialists).toEqual([]);
    const w = createDelegateWiring({ config: CONFIG, parentTools: () => PROCESS });
    faux.setResponses([() => fauxAssistantMessage('nada')]);
    const res = await w.tool.execute('d', { task: 'mira', specialist: 'astrólogo' } as never);
    expect(res.details).toMatchObject({ unknownSpecialist: 'astrólogo' });
    expect(res.details).not.toHaveProperty('specialist');
  });

  it('alias con tildes y mayúsculas («Televisión», «Correos») llegan al especialista bueno', async () => {
    const out = await principal(
      'apaga la tele y mira mi correo',
      {
        ...teleYCorreo('Hecho.'),
        principal: [
          () =>
            fauxAssistantMessage(
              [
                call('delegate', { specialist: 'Televisión', task: 'apaga la tele' }, 'p1'),
                call('delegate', { specialist: 'Correos', task: 'resume' }, 'p2'),
              ],
              { stopReason: 'toolUse' },
            ),
          () => fauxAssistantMessage('Hecho.'),
        ],
      },
      'si',
    );
    expect([...out.specialists].sort()).toEqual(['correo', 'tv']);
    expect(questions.every((q) => q.startsWith('Especialista Tele:'))).toBe(true);
  });
});

describe('e2e: notas y recordatorios', () => {
  const notas: Script = {
    principal: [
      () =>
        fauxAssistantMessage(
          [
            call(
              'delegate',
              {
                specialist: 'recordatorios',
                task: 'apunta lo del fontanero y recuérdamelo el domingo',
              },
              'p1',
            ),
          ],
          { stopReason: 'toolUse' },
        ),
      () => fauxAssistantMessage('Apuntado, y te lo recuerdo el domingo a las 20:00.'),
    ],
    notas: [
      () =>
        fauxAssistantMessage(
          [
            call('memory', { action: 'recall', query: 'fontanero' }, 'n1'),
            call('memory', { action: 'remember', text: 'el lunes viene el fontanero' }, 'n2'),
            call(
              'reminder',
              { action: 'create', text: 'viene el fontanero', at: '2026-11-08T20:00' },
              'n3',
            ),
            call('memory', { action: 'save_profile', text: 'tiene fontanero' }, 'n4'),
          ],
          { stopReason: 'toolUse' },
        ),
      () => fauxAssistantMessage('Nota guardada y recordatorio el domingo a las 20:00.'),
    ],
  };

  it('buscar no pregunta; guardar y programar preguntan una por una; el perfil no se toca', async () => {
    const out = await principal(
      'apunta que el lunes viene el fontanero y recuérdamelo el domingo a las 8 de la tarde',
      notas,
      'si',
    );
    expect(ran).toEqual([
      { name: 'memory', action: 'recall' },
      { name: 'memory', action: 'remember' },
      { name: 'reminder', action: 'create' },
    ]);
    expect(questions).toHaveLength(2);
    expect(questions.every((q) => q.startsWith('Especialista Notas:'))).toBe(true);
    expect(out.specialists).toEqual(['notas']);
    expect(Object.values(childTools)).toEqual([['memory', 'reminder']]);
  });

  it('sin forma de preguntar no se ejecuta, y el motivo habla de tus notas (no de aparatos)', async () => {
    const out = await principal('apunta lo del fontanero', notas, 'sin-canal');
    expect(ran).toEqual([]);
    expect(Object.values(childTools)).toEqual([]);
    expect(out.specialists).toEqual([]);
    const w = createDelegateWiring({ config: CONFIG, parentTools: () => PROCESS });
    const res = await w.tool.execute('d', { task: 'apunta', specialist: 'notas' } as never);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toBe(
      'El especialista Notas cambia tus notas o recordatorios y aquí no tiene forma de pedirte permiso; no se ejecuta.',
    );
  });
});
