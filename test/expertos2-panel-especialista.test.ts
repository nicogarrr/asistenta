import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * El panel web dice qué especialista hizo la tarea (asis-expertos-2, PR 2). El
 * resultado de `delegate` ya lo trae en `details.specialist`; el agente lo pasa en
 * `onToolEnd`, el turno del panel lo recoge y la respuesta acaba con una línea
 * «🧩 Lo hizo el especialista Tele.». Telegram no cambia. Modelo simulado, sin red.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-expertos2-panel-'));
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
const { runPanelChat, specialistNote } = await import('../src/daemon/panel-chat.js');
type PanelChatThread = import('../src/daemon/panel-chat.js').PanelChatThread;

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

function fakeTool(name: string, details: Record<string, unknown>): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: `ok-${name}` }], details }),
  } as unknown as AgentTool;
}

let faux: ReturnType<typeof createFauxCore>;

beforeEach(() => {
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

async function endsOf(tools: AgentTool[], calls: Array<[string, Record<string, unknown>]>) {
  const gate = new Gate({ allow: tools.map((t) => t.name) });
  const agent = await PersonalAgent.create(CONFIG, tools, gate, 'telegram-user', {
    sessionId: `s-${Math.random()}`,
    desktop: false,
  } as never);
  faux.setResponses([
    () =>
      fauxAssistantMessage(
        calls.map(([n, a], i) => fauxToolCall(n, a as never, { id: `c${i}` })),
        { stopReason: 'toolUse' },
      ),
    () => fauxAssistantMessage('Hecho.'),
  ]);
  const ends: Array<{ tool: string; specialist?: string }> = [];
  await agent.run('apaga la tele y mira mi correo', undefined, {
    onToolEnd: (info) => ends.push({ tool: info.tool, specialist: info.specialist }),
  });
  return ends;
}

describe('el agente dice qué especialista terminó', () => {
  it('delegate con details.specialist → onToolEnd lo trae', async () => {
    const ends = await endsOf(
      [fakeTool('delegate', { depth: 1, specialist: 'tv' })],
      [['delegate', { task: 'apaga la tele', specialist: 'tele' }]],
    );
    expect(ends).toEqual([{ tool: 'delegate', specialist: 'tv' }]);
  });

  it('si el especialista no llegó a correr (error) o no es delegate, nada', async () => {
    const ends = await endsOf(
      [
        fakeTool('delegate', {
          depth: 1,
          specialist: 'pc',
          error: 'no tiene forma de pedirte permiso',
        }),
        fakeTool('otra', { specialist: 'tv' }),
      ],
      [
        ['delegate', { task: 'x', specialist: 'pc' }],
        ['otra', {}],
      ],
    );
    expect(ends.map((e) => e.specialist)).toEqual([undefined, undefined]);
  });
});

function fakeThread(): PanelChatThread {
  return { key: 'telegram:dm:1:main', generation: 0, tail: Promise.resolve(), active: false };
}

describe('la respuesta del panel nombra al especialista', () => {
  it('uno: «Lo hizo el especialista Tele.»', async () => {
    const r = await runPanelChat(fakeThread(), 'apaga la tele', {
      remember: () => {},
      runTurn: async (_t, _text, out) => {
        out.specialist?.('tv');
        out.answer('Tele apagada.');
      },
    });
    expect(r.text).toBe('Tele apagada.\n\n🧩 Lo hizo el especialista Tele.');
  });

  it('varios, sin repetir y en orden; un nombre desconocido no sale', async () => {
    const r = await runPanelChat(fakeThread(), 'apaga la tele y mira mi correo', {
      remember: () => {},
      runTurn: async (_t, _text, out) => {
        out.specialist?.('tv');
        out.specialist?.('correo');
        out.specialist?.('tv');
        out.specialist?.('<b>inventado</b>');
        out.answer('Hecho.');
      },
    });
    expect(r.text).toBe('Hecho.\n\n🧩 Lo hicieron los especialistas Tele y Correo.');
  });

  it('sin especialistas la respuesta no cambia', async () => {
    const r = await runPanelChat(fakeThread(), 'hola', {
      remember: () => {},
      runTurn: async (_t, _text, out) => out.answer('hola'),
    });
    expect(r).toEqual({ text: 'hola' });
    expect(specialistNote([])).toBeNull();
    expect(specialistNote(['web', 'calendario', 'hogar'])).toBe(
      '🧩 Lo hicieron los especialistas Web, Calendario y Casa.',
    );
  });
});

describe('cableado real en cli.ts', () => {
  it('el turno pasa el especialista al panel (solo si la salida es del panel)', () => {
    const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const runTurn = async (');
    const block = source.slice(start, start + 30_000);
    // Con salida del panel, al panel; sin ella (Telegram), a la línea del final (expertos-3).
    expect(block).toMatch(
      /onToolEnd: \(info\) => \{[^}]*if \(info\.specialist\) \{\s*if \(out\) out\.specialist\?\.\(info\.specialist\);/s,
    );
  });
});
