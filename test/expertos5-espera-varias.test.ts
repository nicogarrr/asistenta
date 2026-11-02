import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * Dos especialistas preguntando a la vez en Telegram: cada pregunta marca «esperando
 * aprobación» (lo lee la autoactualización para no reiniciar el daemon) y la desmarca al
 * contestarse. La primera respuesta no puede borrar la marca mientras la segunda sigue
 * esperando. Solo el indicador: ningún permiso cambia.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-expertos5-espera-'));
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
const { readBusy, trackBusyIn } = await import('../src/ocupada.js');

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

async function makeAgent() {
  const faux = createFauxCore({ provider: 'test-provider', models: [{ id: 'test-model' }] });
  const model = faux.getModel();
  providerState.handle = {
    model,
    streamFn: faux.streamSimple,
    modelFor: () => model,
    models: { completeSimple: async () => fauxAssistantMessage('') },
    fallbackFor: undefined,
  };
  const tool = {
    name: 'lookup',
    label: 'lookup',
    description: 'fake lookup tool',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  } as unknown as AgentTool;
  const gate = new Gate({
    dbPath: join(stateDir, 'gate.db'),
    grantWindowMs: 0,
    approver: () => false,
  });
  return PersonalAgent.create(CONFIG, [tool], gate, 'test', {
    sessionId: 'expertos5',
    desktop: false,
    iterationBudget: { max: 3 },
  });
}

describe('«esperando aprobación» con varias preguntas a la vez', () => {
  it('la primera respuesta no borra la marca mientras otra pregunta sigue abierta', async () => {
    trackBusyIn(stateDir);
    expect(readBusy(stateDir)).toBe('libre');
    const agent = await makeAgent();

    agent.setAwaitingApproval(true); // especialista de la tele pregunta
    agent.setAwaitingApproval(true); // especialista de notas pregunta a la vez
    expect(readBusy(stateDir)).toBe('ocupada');

    agent.setAwaitingApproval(false); // Nico contesta la primera
    expect(readBusy(stateDir)).toBe('ocupada');

    agent.setAwaitingApproval(false); // y la segunda
    expect(readBusy(stateDir)).toBe('libre');
  });

  it('un «ya no espero» de más no deja el contador en negativo', async () => {
    trackBusyIn(stateDir);
    const agent = await makeAgent();

    agent.setAwaitingApproval(false);
    agent.setAwaitingApproval(false);
    expect(readBusy(stateDir)).toBe('libre');

    agent.setAwaitingApproval(true);
    expect(readBusy(stateDir)).toBe('ocupada');
    agent.setAwaitingApproval(false);
    expect(readBusy(stateDir)).toBe('libre');
  });
});
