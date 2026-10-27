import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, FauxResponseFactory } from '@earendil-works/pi-ai';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';

/**
 * Cableado de `delegate` con el PersonalAgent y la Gate REALES y un modelo
 * simulado (faux): sin red, sin modelo real. Un hijo "malicioso" intenta
 * escribir, ejecutar shell, abrir navegador y pedir aprobacion.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-subagent-wiring-'));
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
const { createChildGate, createDelegateWiring, SUBAGENT_DENIED_TOOLS } = await import(
  '../src/core/subagent-wiring.js'
);
const { SUBAGENT_SAFE_TOOLS } = await import('../src/core/subagent-runner.js');

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

let faux: ReturnType<typeof createFauxCore>;
let seenToolNames: string[][];

function scripted(build: () => AssistantMessage): FauxResponseFactory {
  return (context) => {
    void context;
    return build();
  };
}

function calls(...c: Array<[string, Record<string, string>]>): AssistantMessage {
  return fauxAssistantMessage(
    c.map(([name, args], i) => fauxToolCall(name, args, { id: `c${i}-${name}` })),
    { stopReason: 'toolUse' },
  );
}

const ran: string[] = [];
function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    execute: async () => {
      ran.push(name);
      return { content: [{ type: 'text', text: `resultado-${name}` }], details: {} };
    },
  } as unknown as AgentTool;
}

const ALL_PARENT = [
  'read',
  'list',
  'fetch',
  'web',
  'write',
  'shell',
  'browser',
  'computer',
  'delegate',
  'preguntar',
].map(tool);

beforeEach(() => {
  ran.length = 0;
  seenToolNames = [];
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

describe('Gate del hijo', () => {
  it('es una Gate nueva, distinta de la del padre, y solo permite lectura', async () => {
    const parentApprover = vi.fn(() => true);
    const parent = new Gate({ allow: ['read'], approver: parentApprover });
    const child = createChildGate();
    expect(child).not.toBe(parent);
    for (const name of SUBAGENT_SAFE_TOOLS) {
      expect(
        (
          await child.check('s', {
            tool: name,
            args: { path: 'x', url: 'https://a.es' },
            actor: 'test',
          })
        ).verdict,
      ).toBe('allow');
    }
    for (const name of SUBAGENT_DENIED_TOOLS) {
      const d = await child.check('s', {
        tool: name,
        args: { command: 'echo hola', path: 'x' },
        actor: 'test',
      });
      expect(d.verdict).not.toBe('allow');
    }
    // una herramienta desconocida pediria aprobacion; sin approver se rechaza
    expect(
      (await child.check('s', { tool: 'inventada', args: {}, actor: 'test' })).verdict,
    ).not.toBe('allow');
    expect(parentApprover).not.toHaveBeenCalled();
  });

  it('el hijo no hereda aprobaciones ni "siempre" del padre', async () => {
    const parent = new Gate({ allow: [], approver: () => true });
    await parent.check('p', { tool: 'shell', args: { command: 'echo hola' }, actor: 'test' });
    const child = createChildGate();
    expect(
      (await child.check('p', { tool: 'shell', args: { command: 'echo hola' }, actor: 'test' }))
        .verdict,
    ).not.toBe('allow');
  });
});

describe('e2e delegate con modelo simulado', () => {
  function wiring() {
    return createDelegateWiring({
      config: CONFIG,
      parentTools: () => ALL_PARENT,
      // Registra el toolset REAL que recibe el hijo y crea el PersonalAgent de verdad.
      createAgent: (config, tools, gate, actor, opts) => {
        seenToolNames.push(tools.map((t) => t.name));
        return PersonalAgent.create(config, tools, gate, actor, opts);
      },
    });
  }

  it('hijo malicioso: write, shell, browser, computer, delegate y preguntar no se ejecutan; read si', async () => {
    const { tool: delegate } = wiring();
    faux.setResponses([
      scripted(() =>
        calls(
          ['write', { path: 'x.txt', content: 'pwn' }],
          ['shell', { command: 'rm -rf /' }],
          ['browser', { action: 'open', url: 'https://example.com' }],
          ['computer', { action: 'click' }],
          ['delegate', { task: 'recursion' }],
          ['preguntar', { question: 'me das permiso?' }],
          ['read', { path: 'notas.md' }],
        ),
      ),
      scripted(() => fauxAssistantMessage('Resumen del hijo.')),
    ]);
    const res = await delegate.execute('1', { task: 'explora', role: 'explorer' } as never);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Resumen del hijo.');
    expect(ran).toEqual(['read']);
    // el hijo ni siquiera ve las herramientas con efectos
    for (const name of ['write', 'shell', 'browser', 'computer', 'delegate', 'preguntar']) {
      expect(seenToolNames[0]).not.toContain(name);
    }
    expect(seenToolNames[0]).toEqual(expect.arrayContaining(['read', 'list', 'fetch', 'web']));
  });

  it('rol implementer: no escribe y no tiene red; solo read/list', async () => {
    const { tool: delegate } = wiring();
    faux.setResponses([
      scripted(() =>
        calls(
          ['write', { path: 'a.ts', content: 'x' }],
          ['fetch', { url: 'https://a.es' }],
          ['list', { path: '.' }],
        ),
      ),
      scripted(() => fauxAssistantMessage('diff propuesto')),
    ]);
    await delegate.execute('1', { task: 'cambia a.ts', role: 'implementer' } as never);
    expect(ran).toEqual(['list']);
    expect(seenToolNames[0]).toEqual(expect.arrayContaining(['read', 'list']));
    expect(seenToolNames[0]).not.toContain('write');
    expect(seenToolNames[0]).not.toContain('fetch');
  });

  it('tools: [] explicito deja al hijo sin herramientas', async () => {
    const { tool: delegate } = wiring();
    faux.setResponses([scripted(() => fauxAssistantMessage('solo texto'))]);
    const res = await delegate.execute('1', {
      task: 'piensa',
      role: 'explorer',
      tools: [],
    } as never);
    expect((res.content[0] as { text: string }).text).toContain('solo texto');
    expect(seenToolNames[0]).toEqual([]);
  });

  it('hijo nuevo por tarea: el segundo no ve el contexto del primero', async () => {
    const { tool: delegate } = wiring();
    const contexts: unknown[] = [];
    faux.setResponses([
      (ctx) => {
        contexts.push(JSON.stringify((ctx as { messages?: unknown }).messages));
        return fauxAssistantMessage('A-hecho');
      },
      (ctx) => {
        contexts.push(JSON.stringify((ctx as { messages?: unknown }).messages));
        return fauxAssistantMessage('B-hecho');
      },
    ]);
    await delegate.execute('1', { task: 'tarea-A-secreta' } as never);
    await delegate.execute('2', { task: 'tarea-B' } as never);
    expect(String(contexts[1])).not.toContain('tarea-A-secreta');
    expect(String(contexts[1])).not.toContain('A-hecho');
  });

  it('defensa en profundidad: si una tool con efectos se colara, la Gate la rechaza', async () => {
    const gate = createChildGate();
    const agent = await PersonalAgent.create(
      CONFIG,
      [tool('read'), tool('write'), tool('shell')],
      gate,
      'subagent',
      {
        sessionId: 'sub-leak',
        desktop: false,
        iterationBudget: { max: 5 },
      },
    );
    faux.setResponses([
      scripted(() =>
        calls(
          ['write', { path: 'x', content: 'y' }],
          ['shell', { command: 'echo hola' }],
          ['read', { path: 'ok' }],
        ),
      ),
      scripted(() => fauxAssistantMessage('fin')),
    ]);
    const r = await agent.run('intenta escribir');
    expect(ran).toEqual(['read']);
    expect(r.blocked).toBeGreaterThanOrEqual(2);
  });

  it('el pool respeta la profundidad: delegate desde profundidad 1 se rechaza', async () => {
    const { pool } = wiring();
    const r = await pool.run({ task: 'nieto', parentDepth: pool.limits.maxDepth });
    expect(r.error).toBeTruthy();
    expect(ran).toEqual([]);
  });
});

describe('Telegram thread tool registration', () => {
  it('registers each tool factory once in the actual threadTools array', () => {
    const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const threadTools = (thread: Thread): AgentTool[] => {');
    const end = source.indexOf('const raw = toolsForMode(all, desktop);', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    // Source-registration guard for this CLI-local factory. Runtime child tool
    // isolation and tool names are exercised separately above with real agents.
    const factories = [...block.matchAll(/^ {6}([A-Za-z][A-Za-z0-9_]*)\(/gm)].map((m) => m[1]);
    expect(factories.filter((name) => name === 'delegateTool')).toHaveLength(1);
    expect(new Set(factories).size).toBe(factories.length);
  });
});
