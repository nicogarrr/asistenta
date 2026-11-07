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
 * Rutas aprendidas (idea de POKI, reescrita): una tarea de navegador que salió bien se
 * guarda como receta con huecos y la próxima vez se repite sin preguntar al modelo en cada
 * paso, por el mismo bucle y el mismo control de permisos. En cuanto un paso no sale como
 * la otra vez, el modelo sigue desde ahí. Bucle real contra un modelo falso.
 *
 * End-to-end loop against a scripted provider: the real `PersonalAgent` and the
 * real `Gate`, a fake model that answers from a queue, and fake tools that record
 * whether they ever ran. No network and no real state dir.
 *
 * The provider handle is mocked because `PersonalAgent.create` builds one
 * internally; every other moving part (agent loop, gate, budget, hooks) is the
 * production implementation.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-rutas-'));
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
const { learnRoute, matchRoute, RouteStore, routeAfterTurn, IRREVERSIBLE, refsOf } = await import(
  '../src/core/rutas.js'
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

/** Navegador falso: apunta cada llamada y devuelve el texto que se le dé por acción. */
function fakeBrowser(answers: Record<string, string> = {}) {
  const ran: Record<string, unknown>[] = [];
  const tool = {
    name: 'browser',
    label: 'browser',
    description: 'fake browser',
    parameters: { type: 'object', properties: { action: { type: 'string' } } },
    execute: async (_id: string, args: unknown) => {
      ran.push(args as Record<string, unknown>);
      const action = String((args as { action?: unknown }).action ?? '');
      return { content: [{ type: 'text', text: answers[action] ?? 'ok' }], details: {} };
    },
  } as unknown as AgentTool;
  return { tool, ran };
}

function browserCall(id: string, args: Record<string, unknown>): AssistantMessage {
  return fauxAssistantMessage([fauxToolCall('browser', args as never, { id })], {
    stopReason: 'toolUse',
  });
}

const OPEN = { action: 'open', url: 'https://tienda.example/' };
const FILL = (text: string) => ({ action: 'fill', selector: '#buscar', text });
const CLICK = { action: 'click', selector: 'Buscar' };
const ASK = 'mira el precio de leche en la tienda';

/** Lo que el modelo falso vio (texto) en su última petición. */
function lastContextText(): string {
  return JSON.stringify(contexts.at(-1)?.messages ?? []);
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

describe('rutas aprendidas: aprender', () => {
  it('un turno de navegador que salió bien deja una receta con huecos', async () => {
    faux.setResponses([
      scripted(() => browserCall('a1', OPEN)),
      scripted(() => browserCall('a2', FILL('leche'))),
      scripted(() => browserCall('a3', CLICK)),
      scripted(() => browserCall('a4', { action: 'snapshot' })),
      scripted(() => fauxAssistantMessage('La leche cuesta 1,05 €.')),
    ]);
    const { tool } = fakeBrowser({ snapshot: 'Leche entera 1,05 €' });
    const agent = await makeAgent(tool, makeGate({ allow: ['browser'] }), {}, 10);
    const result = await agent.run(ASK);
    const route = learnRoute(ASK, result.trail ?? []);
    expect(route?.template).toBe('mira el precio de {{p1}} en la tienda');
    expect(route?.steps.map((s) => s.args)).toEqual([OPEN, FILL('{{p1}}'), CLICK]);
  });

  it('nunca con pagos, contraseñas del vault, avisos u otras herramientas que hacen cosas', () => {
    const ok = { tool: 'browser', ok: true };
    const base = [
      { ...ok, args: OPEN },
      { ...ok, args: FILL('leche') },
    ];
    expect(learnRoute(ASK, [...base, { ...ok, args: CLICK }])).not.toBeNull();
    expect(
      learnRoute(ASK, [...base, { ...ok, args: { action: 'click', selector: 'Pagar ahora' } }]),
    ).toBeNull();
    expect(
      learnRoute(ASK, [
        ...base,
        { ...ok, args: { action: 'click', selector: 'Confirmar pedido' } },
      ]),
    ).toBeNull();
    expect(
      learnRoute(ASK, [
        ...base,
        { ...ok, args: { action: 'fill', selector: '#pw', secret_key: 'k' } },
      ]),
    ).toBeNull();
    expect(
      learnRoute(ASK, [
        ...base,
        { ...ok, args: CLICK, warn: 'el último clic no cambió la página' },
      ]),
    ).toBeNull();
    expect(
      learnRoute(ASK, [
        ...base,
        { tool: 'mail', ok: true, args: { action: 'send' } },
        { ...ok, args: CLICK },
      ]),
    ).toBeNull();
    expect(
      learnRoute(ASK, [...base, { ...ok, args: { action: 'exec_js', code: 'x' } }]),
    ).toBeNull();
    expect(IRREVERSIBLE.test('Finalizar compra')).toBe(true);
    expect(IRREVERSIBLE.test('Añadir al carrito')).toBe(false);
  });

  it('un ref del snapshot (e12) se guarda como el texto del elemento, nunca como ref', () => {
    const snap = {
      tool: 'browser',
      ok: true,
      args: { action: 'snapshot' },
      refs: { e7: 'Buscar', e9: '/carrito' },
    };
    const base = [
      snap,
      { tool: 'browser', ok: true, args: OPEN },
      { tool: 'browser', ok: true, args: FILL('leche') },
    ];
    const route = learnRoute(ASK, [
      ...base,
      { tool: 'browser', ok: true, args: { action: 'click', selector: 'e7' } },
    ]);
    expect(route?.steps[2]?.args.selector).toBe('Buscar');
    // Un ref sin nombre visible, o que es una dirección: no se aprende.
    expect(
      learnRoute(ASK, [
        ...base,
        { tool: 'browser', ok: true, args: { action: 'click', selector: '@e9' } },
      ]),
    ).toBeNull();
    expect(
      learnRoute(ASK, [
        ...base,
        { tool: 'browser', ok: true, args: { action: 'click', selector: 'e40' } },
      ]),
    ).toBeNull();
    expect(refsOf('e7[button] "Buscar"\n  e9[link] "/carrito"')).toEqual({
      e7: 'Buscar',
      e9: '/carrito',
    });
  });

  it('reconoce la misma petición con otro valor, con tildes y mayúsculas', () => {
    const route = learnRoute(ASK, [
      { tool: 'browser', ok: true, args: OPEN },
      { tool: 'browser', ok: true, args: FILL('leche') },
      { tool: 'browser', ok: true, args: CLICK },
    ]);
    if (!route) throw new Error('sin ruta');
    const match = matchRoute('Mira el precio de Huevos camperos en la tienda.', [route]);
    expect(match?.values).toEqual({ p1: 'Huevos camperos' });
    expect(match?.steps[1]?.args.text).toBe('Huevos camperos');
    expect(matchRoute('mira el tiempo en Madrid', [route])).toBeNull();
  });
});

describe('rutas aprendidas: repetir', () => {
  const learned = () => {
    const route = learnRoute(ASK, [
      { tool: 'browser', ok: true, args: OPEN },
      { tool: 'browser', ok: true, args: FILL('leche') },
      { tool: 'browser', ok: true, args: CLICK },
    ]);
    if (!route) throw new Error('sin ruta');
    return route;
  };

  it('repite los pasos sin preguntar al modelo; el modelo solo contesta al final', async () => {
    faux.setResponses([
      scripted(() => fauxAssistantMessage('Los huevos cuestan 2,10 €. (ruta aprendida)')),
    ]);
    const { tool, ran } = fakeBrowser({ click: 'clicked "Buscar"' });
    const agent = await makeAgent(tool, makeGate({ allow: ['browser'] }), {}, 10);
    const match = matchRoute('mira el precio de huevos en la tienda', [learned()]);
    const result = await agent.run('mira el precio de huevos en la tienda', undefined, {
      route: match,
    });
    expect(ran).toEqual([OPEN, FILL('huevos'), CLICK]);
    // Una sola petición al modelo, y sin llamadas que no hizo él: la ruta va en una nota.
    expect(contexts).toHaveLength(1);
    const seen = lastContextText();
    expect(seen).toContain('Ruta aprendida');
    expect(seen).not.toContain('ruta_');
    expect(result.route).toMatchObject({ status: 'ok', steps: 3 });
    expect(result.text).toContain('2,10');
  });

  it('si un paso no sale como la otra vez, para ahí y sigue el modelo sabiendo qué está hecho', async () => {
    faux.setResponses([
      scripted(() => browserCall('m1', { action: 'snapshot' })),
      scripted(() => fauxAssistantMessage('No encuentro el buscador; la tienda ha cambiado.')),
    ]);
    const { tool, ran } = fakeBrowser({ fill: 'ATENCIÓN: no se pudo verificar el campo.' });
    const agent = await makeAgent(tool, makeGate({ allow: ['browser'] }), {}, 10);
    const match = matchRoute('mira el precio de huevos en la tienda', [learned()]);
    const result = await agent.run('mira el precio de huevos en la tienda', undefined, {
      route: match,
    });
    // El clic no se llegó a mandar: la ruta paró en el paso 2.
    expect(ran.map((a) => a.action)).toEqual(['open', 'fill', 'snapshot']);
    expect(JSON.stringify(contexts[0]?.messages)).toContain('Se paró en el paso 2');
    expect(result.route?.status).toBe('mismatch');
  });

  it('si Nico escribe a media ruta, la receta se para y contesta el modelo', async () => {
    const { loadReplay, scriptedStep, startReplay } = await import('../src/core/rutas-replay.js');
    await loadReplay();
    const match = matchRoute('mira el precio de huevos en la tienda', [learned()]);
    if (!match) throw new Error('sin ruta');
    const state = startReplay(match);
    const model = { api: 'faux', provider: 'faux', id: 'faux' } as never;
    expect(scriptedStep(state, model, undefined, [{ role: 'user' }])).not.toBeNull();
    state.done = 1;
    expect(
      scriptedStep(state, model, undefined, [{ role: 'toolResult' }, { role: 'user' }]),
    ).toBeNull();
    expect(state.status).toBe('mismatch');
  });

  it('los pasos repetidos pasan por el control de permisos: si no hay permiso, no se hacen', async () => {
    faux.setResponses([
      scripted(() => fauxAssistantMessage('No tengo permiso para usar el navegador.')),
    ]);
    const { tool, ran } = fakeBrowser();
    const agent = await makeAgent(tool, makeGate({ deny: ['browser'] }), {}, 10);
    const match = matchRoute('mira el precio de huevos en la tienda', [learned()]);
    const result = await agent.run('mira el precio de huevos en la tienda', undefined, {
      route: match,
    });
    expect(ran).toEqual([]);
    expect(result.route?.status).toBe('mismatch');
  });

  it('PA_RUTAS_APRENDIDAS=0: no se repite nada, pregunta el modelo como siempre', async () => {
    process.env.PA_RUTAS_APRENDIDAS = '0';
    try {
      faux.setResponses([scripted(() => fauxAssistantMessage('Vale.'))]);
      const { tool, ran } = fakeBrowser();
      const agent = await makeAgent(tool, makeGate({ allow: ['browser'] }), {}, 10);
      const match = matchRoute('mira el precio de huevos en la tienda', [learned()]);
      const result = await agent.run('mira el precio de huevos en la tienda', undefined, {
        route: match,
      });
      expect(ran).toEqual([]);
      expect(result.route).toBeUndefined();
    } finally {
      delete process.env.PA_RUTAS_APRENDIDAS;
    }
  });
});

describe('rutas aprendidas: guardar', () => {
  it('aprende una vez y avisa; dos fallos seguidos la olvidan', () => {
    const store = new RouteStore(join(stateDir, `rutas-${Date.now()}.json`));
    const trail = [
      { tool: 'browser', ok: true, args: OPEN },
      { tool: 'browser', ok: true, args: FILL('leche') },
      { tool: 'browser', ok: true, args: CLICK },
    ];
    const line = routeAfterTurn(store, ASK, { error: null, blocked: 0, trail }, null);
    expect(line).toContain('«mira el precio de … en la tienda»');
    // La misma otra vez: se sustituye, sin repetir el aviso.
    expect(routeAfterTurn(store, ASK, { error: null, blocked: 0, trail }, null)).toBeNull();
    expect(store.list()).toHaveLength(1);
    // Un turno con aviso del revisor del «hecho» no enseña nada.
    expect(
      routeAfterTurn(store, 'otra cosa distinta', { error: null, blocked: 0, trail }, '⚠️'),
    ).toBeNull();
    const id = store.list()[0]?.id ?? '';
    routeAfterTurn(
      store,
      ASK,
      { error: null, blocked: 0, route: { id, status: 'mismatch' } },
      null,
    );
    expect(store.list()).toHaveLength(1);
    routeAfterTurn(
      store,
      ASK,
      { error: null, blocked: 0, route: { id, status: 'mismatch' } },
      null,
    );
    expect(store.list()).toHaveLength(0);
    // Y se lee del disco.
    const again = new RouteStore(join(stateDir, 'no-existe.json'));
    expect(again.list()).toEqual([]);
  });
});
