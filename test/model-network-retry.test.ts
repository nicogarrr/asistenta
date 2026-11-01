import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, FauxResponseFactory } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * «Hola» en Telegram contestado con «Fallo: fetch failed»: la llamada al modelo
 * se cayó por red y el error crudo llegó al chat. Modelo falso (faux), sin red.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-net-retry-'));
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
const { friendlyModelError, chatReplyText } = await import('../src/core/friendly-error.js');
const { isTransientProviderError, retryAfterMs } = await import('../src/core/retry.js');

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
  retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
  maxToolCalls: 20,
  browserChannel: 'chromium',
  downloadCookiesBrowser: '',
  curlImpersonatePath: '',
};

let faux: ReturnType<typeof createFauxCore>;
let fallbackFor: ReturnType<typeof vi.fn> | undefined;
let gateSeq = 0;

/** Lo que hace un fetch sin red: lanza TypeError('fetch failed'). */
const fetchFailed: FauxResponseFactory = () => {
  throw new TypeError('fetch failed');
};
const errorTurn =
  (message: string): FauxResponseFactory =>
  (): AssistantMessage =>
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: message });
const answer =
  (text: string): FauxResponseFactory =>
  (): AssistantMessage =>
    fauxAssistantMessage(text);

async function makeAgent(config: Partial<Config> = {}) {
  const gate = new Gate({
    dbPath: join(stateDir, `gate-${gateSeq++}.db`),
    grantWindowMs: 0,
    approver: () => true,
  });
  return PersonalAgent.create({ ...CONFIG, ...config }, [], gate, 'test', {
    sessionId: 'net',
    desktop: false,
    iterationBudget: { max: 5 },
  });
}

beforeEach(() => {
  faux = createFauxCore({
    provider: 'test-provider',
    models: [{ id: 'test-model' }, { id: 'fallback-model' }],
    tokenSize: { min: 10_000, max: 10_000 },
  });
  const model = faux.getModel();
  fallbackFor = undefined;
  providerState.handle = {
    model,
    streamFn: faux.streamSimple,
    modelFor: () => model,
    models: { completeSimple: async () => fauxAssistantMessage('') },
    fallbackFor: undefined,
  };
});

describe('fallo de red al hablar con el modelo', () => {
  it('«fetch failed» y los errores de red/DNS se reintentan; la clave mala no', () => {
    for (const e of [
      'fetch failed',
      'TypeError: fetch failed',
      'getaddrinfo ENOTFOUND api.example.com',
      'getaddrinfo EAI_AGAIN api.example.com',
      'connect ECONNREFUSED 127.0.0.1:4096',
      'connect ENETUNREACH',
      'other side closed',
    ]) {
      expect(isTransientProviderError(e), e).toBe(true);
    }
    expect(isTransientProviderError('401 Unauthorized')).toBe(false);
    expect(isTransientProviderError('fetch failed: 401 invalid api key')).toBe(false);
  });

  it('un «Hola» con la red caída una vez: reintenta y contesta normal', async () => {
    faux.setResponses([fetchFailed, answer('¡Hola! ¿En qué te ayudo?')]);
    const agent = await makeAgent();
    const result = await agent.run('Hola');
    expect(result.error).toBeNull();
    expect(result.text).toBe('¡Hola! ¿En qué te ayudo?');
    expect(result.attempts).toBe(2);
  });

  it('si la red sigue caída: se rinde tras los reintentos y el chat no ve el error crudo', async () => {
    faux.setResponses([fetchFailed, fetchFailed, fetchFailed, fetchFailed, answer('no llega')]);
    const agent = await makeAgent();
    const result = await agent.run('Hola');
    expect(result.error).toMatch(/fetch failed/);
    expect(result.attempts).toBe(4);
    const reply = chatReplyText(result);
    expect(reply).not.toMatch(/fetch failed|Fallo:/i);
    expect(reply).toMatch(/No puedo hablar con el modelo/);
  });

  it('un 401 no se reintenta', async () => {
    faux.setResponses([errorTurn('401 Unauthorized: invalid api key'), answer('no llega')]);
    const agent = await makeAgent();
    const result = await agent.run('Hola');
    expect(result.attempts).toBe(1);
    expect(chatReplyText(result)).toMatch(/clave no vale o ha caducado/);
  });

  it('con un modelo de reserva ya configurado: tras dos fallos del principal pasa a la reserva', async () => {
    const fb = faux.getModel('fallback-model');
    fallbackFor = vi.fn(() => fb);
    (providerState.handle as { fallbackFor: unknown }).fallbackFor = fallbackFor;
    faux.setResponses([
      errorTurn('503 Service Unavailable'),
      errorTurn('503 Service Unavailable'),
      answer('Hola desde la reserva'),
    ]);
    const agent = await makeAgent({ fallbackModel: 'fallback-model' });
    const result = await agent.run('Hola');
    expect(fallbackFor).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Hola desde la reserva');
  });

  it('sin reserva configurada no se inventa ninguna', async () => {
    faux.setResponses([
      errorTurn('503 Service Unavailable'),
      errorTurn('503 Service Unavailable'),
      answer('Hola'),
    ]);
    const agent = await makeAgent();
    const result = await agent.run('Hola');
    expect(result.text).toBe('Hola');
    expect(result.attempts).toBe(3);
  });
});

describe('el fallo dicho en claro', () => {
  it('distingue sin internet, servicio caído, límite y clave mala, sin texto crudo', () => {
    const cases: Array<[string, RegExp]> = [
      ['fetch failed', /sin conexión o el servicio no responde/],
      ['getaddrinfo ENOTFOUND api.example.com', /no tiene internet/],
      ['getaddrinfo EAI_AGAIN api.example.com', /no tiene internet/],
      ['503 Service Unavailable', /caído o saturado/],
      ['429 Too Many Requests', /límite de uso/],
      ['401 Unauthorized', /clave no vale/],
      ['402 insufficient funds', /saldo/],
      ['prompt is too long: 300000 tokens', /demasiado larga/],
      ["TypeError: Cannot read properties of undefined (reading 'x')", /fallo interno/],
    ];
    for (const [raw, want] of cases) {
      const msg = friendlyModelError(raw);
      expect(msg, raw).toMatch(want);
      expect(msg, raw).not.toContain(raw);
    }
  });

  it('las razones del guardia ya escritas en español pasan tal cual', () => {
    const guard = 'Te detuve porque superaste el presupuesto de 60 acciones sin terminar.';
    expect(friendlyModelError(guard)).toBe(guard);
  });

  it('una respuesta con texto se entrega tal cual; sin texto ni error, «Sin respuesta.»', () => {
    expect(chatReplyText({ text: ' Hola ', error: 'fetch failed' })).toBe('Hola');
    expect(chatReplyText({ text: '', error: null })).toBe('Sin respuesta.');
  });

  it('el chat ya no construye «Fallo: <error>» con el texto crudo', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).not.toContain(['`Fallo: ', '$', '{result.error}`'].join(''));
    expect(cli).toContain('chatReplyText(result)');
  });
});

describe('retry-after del proveedor', () => {
  it('lee los segundos de «retry-after» / «try again in»', () => {
    expect(retryAfterMs('429 rate limit, retry-after: 7')).toBe(7_000);
    expect(retryAfterMs('Rate limit reached. Please try again in 2.5s.')).toBe(2_500);
    expect(retryAfterMs('503 Service Unavailable')).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
  });
});
