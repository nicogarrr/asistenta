import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context as TranscriptContext } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * PA_MODELO_RAPIDO (lane meta-modelos-1, idea de los modelos especializados de Meta):
 * lo fácil (charla corta, /voz) va al modelo rápido; lo difícil, al principal; si el
 * rápido falla, el turno se repite con el principal. Agente real contra un proveedor
 * de pega con dos modelos que responden distinto.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-fast-route-'));
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
const { classifyRequest, fastRouteFor } = await import('../src/core/router.js');
const { loadConfig } = await import('../src/config.js');

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const CONFIG: Config = {
  webMaxCostEur: 0,
  voiceWake: { engine: 'whisper', owwModel: '', owwThreshold: 0.5 },
  provider: 'test-provider',
  model: 'grande',
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
  retry: { attempts: 0, baseDelayMs: 1, maxDelayMs: 1 },
  maxToolCalls: 20,
  browserChannel: 'chromium',
  downloadCookiesBrowser: '',
  curlImpersonatePath: '',
};

const tool = {
  name: 'lookup',
  label: 'lookup',
  description: 'fake',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ content: [{ type: 'text', text: 'x' }], details: {} }),
} as unknown as AgentTool;

let seen: string[];
let failFast: boolean;

beforeEach(() => {
  seen = [];
  failFast = false;
  const faux = createFauxCore({
    provider: 'test-provider',
    models: [{ id: 'grande' }, { id: 'rapido' }, { id: 'otro' }],
    tokenSize: { min: 10_000, max: 10_000 },
  });
  const reply = (_ctx: TranscriptContext, _o: unknown, _s: unknown, model: { id: string }) => {
    seen.push(model.id);
    if (model.id === 'rapido' && failFast) {
      return fauxAssistantMessage('', { stopReason: 'error', errorMessage: '404 model not found' });
    }
    return fauxAssistantMessage(`respuesta de ${model.id}`) as AssistantMessage;
  };
  faux.setResponses(Array.from({ length: 10 }, () => reply));
  const grande = faux.getModel('grande') ?? faux.getModel();
  const rapido = faux.getModel('rapido') ?? faux.getModel();
  const otro = faux.getModel('otro') ?? faux.getModel();
  providerState.handle = {
    model: grande,
    streamFn: faux.streamSimple,
    modelFor: () => grande,
    modelById: (id: string) => ({ rapido, grande, otro })[id],
    models: { completeSimple: async () => fauxAssistantMessage('') },
    fallbackFor: undefined,
  };
});

function gate(): InstanceType<typeof Gate> {
  return new Gate({
    dbPath: join(stateDir, `gate-${Math.random()}.db`),
    grantWindowMs: 0,
    allow: ['lookup'],
    approver: () => true,
  });
}

async function agent(config: Partial<Config> = {}) {
  return PersonalAgent.create({ ...CONFIG, ...config }, [tool], gate(), 'test', {
    sessionId: `fast-${Math.random()}`,
    desktop: false,
  });
}

const VOZ = (t: string) =>
  `[Por voz desde /voz, transcrito: contesta en 1 a 3 frases cortas y naturales para decirlas en voz alta, sin listas, tablas, enlaces ni emojis, salvo que pida detalle] ${t}`;

describe('fastRouteFor: qué es fácil', () => {
  it('charla y preguntas directas van al rápido; /voz también salvo trabajo de verdad', () => {
    expect(fastRouteFor('hola, ¿qué tal?').fast).toBe(true);
    expect(fastRouteFor('¿qué hora es en Tokio?').fast).toBe(true);
    expect(fastRouteFor(VOZ('ponme al día de lo de mañana')).fast).toBe(true);
    expect(fastRouteFor(VOZ('busca el precio del aceite')).fast).toBe(true);
    expect(fastRouteFor(VOZ('investiga y compara tres portátiles')).fast).toBe(false);
    expect(fastRouteFor('investiga los mejores portátiles de 2026').fast).toBe(false);
    expect(fastRouteFor('implementa la integración con el banco').fast).toBe(false);
    // Lo escrito sin señales no es «fácil»: solo /voz lo trata así.
    expect(fastRouteFor('mi madre dice que el jueves no puede venir a comer').fast).toBe(false);
    expect(fastRouteFor('n3: hola').fast).toBe(false);
    expect(fastRouteFor('n1: investiga esto rápido').fast).toBe(true);
  });
});

describe('classifyRequest: preguntas con «¿»', () => {
  it('«¿qué hora es?» es nivel 1 como «qué hora es»', () => {
    expect(classifyRequest('¿qué hora es en Tokio?').level).toBe(1);
    expect(classifyRequest('qué hora es en Tokio').level).toBe(1);
  });
});

describe('PA_MODELO_RAPIDO en el agente', () => {
  it('lee PA_MODELO_RAPIDO del entorno', () => {
    process.env.PA_MODELO_RAPIDO = 'rapido';
    try {
      expect(loadConfig().fastModel).toBe('rapido');
    } finally {
      delete process.env.PA_MODELO_RAPIDO;
    }
  });

  it('una charla corta va al rápido y la tarea difícil al principal', async () => {
    const a = await agent({ fastModel: 'rapido' });
    const r1 = await a.run('hola, ¿qué tal?');
    expect(r1.text).toContain('respuesta de rapido');
    const r2 = await a.run('investiga los mejores portátiles de 2026');
    expect(r2.text).toContain('respuesta de grande');
    expect(seen).toEqual(['rapido', 'grande']);
    // El rápido es solo por run: el agente vuelve al principal.
    expect(a.agent.state.model.id).toBe('grande');
  });

  it('un turno de /voz va al rápido', async () => {
    const a = await agent({ fastModel: 'rapido' });
    const r = await a.run(VOZ('¿qué tengo mañana?'));
    expect(r.text).toContain('respuesta de rapido');
  });

  it('si el rápido falla, el mismo turno se repite con el principal', async () => {
    failFast = true;
    const a = await agent({ fastModel: 'rapido' });
    const r = await a.run('hola');
    expect(r.error).toBeFalsy();
    expect(r.text).toContain('respuesta de grande');
    expect(seen).toEqual(['rapido', 'grande']);
    expect(a.agent.state.model.id).toBe('grande');
  });

  it('sin PA_MODELO_RAPIDO todo va al principal, como antes', async () => {
    const a = await agent();
    await a.run('hola');
    expect(seen).toEqual(['grande']);
  });

  it('/modelo manda: con un modelo elegido no hay ruta rápida', async () => {
    const a = await agent({ fastModel: 'rapido', extraModels: ['otro'] });
    expect(a.chooseModel('otro').ok).toBe(true);
    await a.run('hola');
    expect(seen).toEqual(['otro']);
  });
});
