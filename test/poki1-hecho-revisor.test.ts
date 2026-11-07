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
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * Revisor del «hecho» (idea de POKI, reescrita): si Asistenta dice «hecho» pero la última
 * acción dejó un aviso o falló y nadie lo miró, la respuesta lo dice. Aquí, el bucle real
 * contra un modelo falso, como en agent-cancellation.test.ts.
 *
 * End-to-end loop against a scripted provider: the real `PersonalAgent` and the
 * real `Gate`, a fake model that answers from a queue, and fake tools that record
 * whether they ever ran. No network and no real state dir.
 *
 * The provider handle is mocked because `PersonalAgent.create` builds one
 * internally; every other moving part (agent loop, gate, budget, hooks) is the
 * production implementation.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-hecho-'));
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
const { claimsDone, doneCheckLine, stepWarning, unverifiedDone } = await import(
  '../src/core/hecho.js'
);

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

/** Navegador falso: devuelve el texto que se le dé para cada acción. */
function fakeBrowser(answers: Record<string, string>): AgentTool {
  return {
    name: 'browser',
    label: 'browser',
    description: 'fake browser',
    parameters: { type: 'object', properties: { action: { type: 'string' } } },
    execute: async (_id: string, args: unknown) => {
      const action = String((args as { action?: unknown }).action ?? '');
      return { content: [{ type: 'text', text: answers[action] ?? 'ok' }], details: {} };
    },
  } as unknown as AgentTool;
}

function browserCall(id: string, action: string): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall('browser', { action }, { id })], {
    stopReason: 'toolUse',
  });
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('revisor del «hecho»: el bucle real', () => {
  it('un «hecho» tras un clic que no quedó comprobado lleva el aviso', async () => {
    faux.setResponses([
      scripted(() => browserCall('c1', 'click')),
      scripted(() => fauxAssistantMessage('Hecho, añadido al carrito.')),
    ]);
    const agent = await makeAgent(
      fakeBrowser({
        click:
          'clicked "Añadir"\nSELECCION_NO_CORROBORADA: la página NO muestra "Leche" tras el clic.',
      }),
      makeGate({ allow: ['browser'] }),
    );
    const result = await agent.run('añade leche al carrito');
    expect(result.steps[0]?.warn).toBe('la página no mostró lo que se eligió');
    const line = doneCheckLine(result, {});
    expect(line).toContain('no lo he podido comprobar');
    expect(line).toContain('la página no mostró lo que se eligió');
    expect(doneCheckLine(result, { PA_VERIFICAR_HECHO: '0' })).toBeNull();
  });

  it('si después miró la página (snapshot), su «hecho» se respeta', async () => {
    faux.setResponses([
      scripted(() => browserCall('c1', 'click')),
      scripted(() => browserCall('c2', 'snapshot')),
      scripted(() => fauxAssistantMessage('Hecho, añadido al carrito.')),
    ]);
    const agent = await makeAgent(
      fakeBrowser({
        click: 'SIN_CAMBIOS: tras el clic la página no cambió',
        snapshot: 'Carrito (1)',
      }),
      makeGate({ allow: ['browser'] }),
    );
    const result = await agent.run('añade leche al carrito');
    expect(doneCheckLine(result, {})).toBeNull();
  });

  it('un clic limpio y «hecho»: sin aviso', async () => {
    faux.setResponses([
      scripted(() => browserCall('c1', 'click')),
      scripted(() => fauxAssistantMessage('Listo.')),
    ]);
    const agent = await makeAgent(
      fakeBrowser({ click: 'clicked' }),
      makeGate({ allow: ['browser'] }),
    );
    const result = await agent.run('pulsa el botón');
    expect(result.steps[0]?.warn).toBeUndefined();
    expect(doneCheckLine(result, {})).toBeNull();
  });
});

describe('revisor del «hecho»: reglas', () => {
  it('reconoce cuándo la respuesta dice que está hecho', () => {
    expect(claimsDone('Hecho, ya lo tienes.')).toBe(true);
    expect(claimsDone('He añadido la leche al carrito.')).toBe(true);
    expect(claimsDone('Ya está enviado.')).toBe(true);
    expect(claimsDone('Mañana lloverá en Madrid.')).toBe(false);
    expect(claimsDone('Aquí tienes la lista de la compra.')).toBe(false);
    expect(claimsDone('El hecho de que llueva no cambia nada.')).toBe(false);
    // Si ya avisa de que no pudo, no hace falta otro aviso.
    expect(claimsDone('Lo intenté pero no he podido añadirlo: hecho a medias.')).toBe(false);
  });

  it('una última acción con error no comprobada: aviso; una lectura no cuenta como acción', () => {
    const steps = [
      { tool: 'browser', action: 'fill', ok: false },
      { tool: 'web', action: '', ok: true },
    ];
    expect(unverifiedDone('Hecho.', steps)).toBe('la última acción (browser · fill) dio error');
    expect(unverifiedDone('Hecho.', [])).toBeNull();
    expect(
      unverifiedDone('Hecho.', [{ tool: 'browser', action: 'snapshot', ok: false }]),
    ).toBeNull();
  });

  it('los avisos de las herramientas se traducen a un motivo llano', () => {
    expect(stepWarning('SIN_CAMBIOS: ...')).toBe('el último clic no cambió la página');
    expect(stepWarning('ATENCIÓN: el campo no quedó con el valor del vault.')).toBe(
      'un campo no quedó comprobado',
    );
    expect(stepWarning('clicked')).toBe('');
  });
});

describe('antes de decir «no está»', () => {
  it('la herramienta del navegador pide bajar y «ver más» hasta que no salga nada nuevo', async () => {
    const { createBrowserTool } = await import('../src/tools/browser.js');
    const tool = createBrowserTool({} as never, () => 'test');
    expect(tool.description).toContain('BEFORE SAYING SOMETHING IS NOT THERE');
    expect(tool.description).toContain('Ver más');
  });
});
