import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Model } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { rewindLastTurn } from '../src/retry-turn.js';

/**
 * F7 /reintentar y /compactar contra el PersonalAgent real con un modelo falso:
 * hasta ahora solo había tests de los helpers puros (rewindLastTurn, LastTurns).
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-reintentar-'));
process.env.PA_STATE_DIR = stateDir;

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

let faux: ReturnType<typeof createFauxCore>;
let seen: string[] = [];
let contexts: string[] = [];
let summary = 'RESUMEN: hablamos del viaje a Lisboa';
let gateSeq = 0;

function handle(withModelById: boolean): void {
  const model = faux.getModel();
  const registered: Record<string, Model<string>> = {
    'test-model': model,
    'alt-model': { ...model, id: 'alt-model', name: 'alt-model' },
  };
  providerState.handle = {
    model,
    streamFn: (m: Model<string>, ctx: unknown, opts: unknown) => {
      seen.push(m.id);
      contexts.push(JSON.stringify(ctx));
      return (faux.streamSimple as (...a: unknown[]) => unknown)(m, ctx, opts);
    },
    modelFor: () => model,
    models: { completeSimple: async () => fauxAssistantMessage(summary) },
    fallbackFor: undefined,
    modelById: withModelById ? (id: string) => registered[id] : undefined,
  };
}

async function makeAgent(config: Partial<Config> = {}) {
  const gate = new Gate({
    dbPath: join(stateDir, `gate-${gateSeq++}.db`),
    grantWindowMs: 0,
    approver: () => true,
  });
  return PersonalAgent.create({ ...CONFIG, ...config }, [], gate, 'test', {
    sessionId: `reintentar-${gateSeq}`,
    desktop: false,
    iterationBudget: { max: 5 },
  });
}

beforeEach(() => {
  seen = [];
  contexts = [];
  summary = 'RESUMEN: hablamos del viaje a Lisboa';
  faux = createFauxCore({
    provider: 'test-provider',
    models: [{ id: 'test-model' }],
    tokenSize: { min: 10_000, max: 10_000 },
  });
  handle(true);
});

const has = (agent: { messages: unknown[] }, text: string): boolean =>
  JSON.stringify(agent.messages).includes(text);

describe('/reintentar con el agente real', () => {
  it('quita la respuesta anterior y el modelo no la ve al repetir', async () => {
    const agent = await makeAgent();
    faux.setResponses([
      fauxAssistantMessage('respuesta uno'),
      fauxAssistantMessage('RESPUESTA MALA'),
      fauxAssistantMessage('RESPUESTA BUENA'),
    ]);
    await agent.run('hola');
    const mark = agent.messages.length;
    const compactions = agent.compactions;
    await agent.run('¿qué tiempo hace?');
    expect(has(agent, 'RESPUESTA MALA')).toBe(true);

    const removed = rewindLastTurn(
      { agent, mark, compactions },
      { agent, messages: agent.messages, compactions: agent.compactions },
    );
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(agent.messages.length).toBe(mark);
    expect(has(agent, 'RESPUESTA MALA')).toBe(false);

    await agent.run('¿qué tiempo hace?');
    expect(contexts.at(-1)).not.toContain('RESPUESTA MALA');
    expect(has(agent, 'RESPUESTA BUENA')).toBe(true);
    expect(has(agent, 'respuesta uno')).toBe(true);
    // La pregunta queda una sola vez en el historial.
    expect(JSON.stringify(agent.messages).split('¿qué tiempo hace?').length - 1).toBe(1);
  });

  it('no rebobina un historial que es de otro agente', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    faux.setResponses([fauxAssistantMessage('de a'), fauxAssistantMessage('de b')]);
    await a.run('hola a');
    await b.run('hola b');
    const before = b.messages.length;
    const removed = rewindLastTurn(
      { agent: a, mark: 1, compactions: 0 },
      { agent: b, messages: b.messages, compactions: b.compactions },
    );
    expect(removed).toBe(0);
    expect(b.messages.length).toBe(before);
  });
});

describe('/compactar con el agente real', () => {
  it('con poco historial no resume y lo dice', async () => {
    const agent = await makeAgent();
    faux.setResponses([fauxAssistantMessage('vale')]);
    await agent.run('hola');
    const r = await agent.compactNow();
    expect(r.compacted).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(agent.compactions).toBe(0);
  });

  it('resume un historial largo, conserva el resumen y /reintentar ya no rebobina', async () => {
    const agent = await makeAgent();
    const turns = 30;
    faux.setResponses(
      Array.from({ length: turns }, (_, i) =>
        fauxAssistantMessage(`respuesta ${i} ${'x'.repeat(4000)}`),
      ),
    );
    let mark = 0;
    for (let i = 0; i < turns; i++) {
      if (i === turns - 1) mark = agent.messages.length;
      await agent.run(`mensaje ${i} ${'y'.repeat(4000)}`);
    }
    const lengthBefore = agent.messages.length;
    // Lo que /reintentar recordaría justo ahora (el historial largo ya pudo
    // compactarse solo durante los turnos).
    const c0 = agent.compactions;
    mark = lengthBefore - 2;
    const r = await agent.compactNow();
    expect(r).toMatchObject({ compacted: true });
    expect(r.after).toBeLessThan(r.before);
    expect(agent.compactions).toBe(c0 + 1);
    expect(agent.messages.length).toBeLessThan(lengthBefore);
    expect(has(agent, 'RESUMEN: hablamos del viaje a Lisboa')).toBe(true);

    // Los índices viejos ya no valen: rebobinar no debe borrar nada.
    const kept = agent.messages.length;
    const removed = rewindLastTurn(
      { agent, mark, compactions: c0 },
      { agent, messages: agent.messages, compactions: agent.compactions },
    );
    expect(removed).toBe(0);
    expect(agent.messages.length).toBe(kept);

    // El turno siguiente lleva el resumen al modelo.
    faux.setResponses([fauxAssistantMessage('sigo')]);
    await agent.run('¿de qué hablábamos?');
    expect(contexts.at(-1)).toContain('RESUMEN: hablamos del viaje a Lisboa');
  });
});
