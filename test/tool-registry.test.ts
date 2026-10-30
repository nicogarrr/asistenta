import { readFileSync } from 'node:fs';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { baseTools, MACHINE_TOOLS } from '../src/core/tool-registry.js';
import type { ActionGate, ScreenBackend } from '../src/tools/computer.js';

/**
 * Registro único de herramientas del núcleo (paso P0 del plan de cohesión).
 * Fija tres cosas: el conjunto de herramientas que mueven la máquina, la lista base
 * que comparten `pa chat` y `pa run`, y que el computer use de esa lista obedece a la
 * puerta que le pasa quien llama (nunca una propia ni ninguna).
 */

function makeConfig(): Config {
  return {
    webMaxCostEur: 0,
    voiceWake: { engine: 'whisper', owwModel: '', owwThreshold: 0.5 },
    provider: 'test',
    model: 'test',
    baseUrl: 'http://localhost',
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 32_000,
    dailyBudgetEur: 0,
    toolTimeoutMs: 5_000,
    runTimeoutMs: 5_000,
    idleTimeoutMs: 5_000,
    screenshotMaxEdge: 1280,
    screenshotQuality: 80,
    verifyActions: false,
    verifySettleMs: 1,
    cron: [],
    retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    maxToolCalls: 10,
    downloadCookiesBrowser: '',
    curlImpersonatePath: '',
    browserChannel: 'chrome',
  } as Config;
}

/** Pantalla falsa: apunta cada método que se llama y nunca mueve nada de verdad. */
function fakeScreen(): { screen: ScreenBackend; calls: string[] } {
  const calls: string[] = [];
  const shot = {
    image: Buffer.from('frame'),
    mimeType: 'image/jpeg',
    width: 1280,
    height: 720,
  };
  const screen = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'then'
          ? undefined
          : (...args: unknown[]) => {
              calls.push(`${String(prop)}:${args.map((a) => JSON.stringify(a)).join(',')}`);
              return Promise.resolve(shot);
            },
    },
  ) as ScreenBackend;
  return { screen, calls };
}

const fakeDelegate = {
  name: 'delegate',
  label: 'delegate',
  description: 'test',
  parameters: {},
  execute: async () => ({ content: [], details: {} }),
} as unknown as AgentTool;

function build(gate: ActionGate) {
  const { screen, calls } = fakeScreen();
  const tools = baseTools({
    config: makeConfig(),
    screen,
    computerGate: gate,
    delegate: fakeDelegate,
    onFactoryChange: () => {},
  });
  return { tools, calls };
}

describe('tool-registry', () => {
  it('MACHINE_TOOLS son exactamente las que mueven la máquina', () => {
    expect([...MACHINE_TOOLS].sort()).toEqual(
      ['browser', 'checkout', 'computer', 'media', 'shell', 'write'].sort(),
    );
  });

  it('la lista base lleva ficheros, web, fábrica, shell, delegate y computer use, en orden', () => {
    const { tools } = build(() => ({ verdict: 'allow', reason: '' }));
    const names = tools.map((t) => t.name);
    expect(names.slice(0, 3)).toEqual(['read', 'write', 'list']);
    expect(names).toContain('fetch');
    expect(names).toContain('web');
    expect(names).toContain('done');
    expect(names).toContain('shell');
    expect(names.at(-2)).toBe('delegate');
    expect(names.at(-1)).toBe('computer');
    expect(new Set(names).size).toBe(names.length);
    // El delegate es el que construye quien llama (un pool por proceso), no uno nuevo.
    expect(tools.find((t) => t.name === 'delegate')).toBe(fakeDelegate);
  });

  it('el computer use de la lista base obedece a la puerta que recibe', async () => {
    const seen: string[] = [];
    const { tools, calls } = build((call) => {
      seen.push(String(call.args.action));
      return { verdict: 'deny', reason: 'no' };
    });
    const computer = tools.find((t) => t.name === 'computer');
    expect(computer).toBeDefined();
    await computer
      ?.execute('t1', {
        action: 'batch',
        actions: [{ action: 'type', text: 'hola' }],
      } as never)
      .catch(() => undefined);
    expect(seen).toEqual(['type']);
    expect(calls.some((c) => c.startsWith('type'))).toBe(false);
  });

  it('cli.ts usa el registro: sin listas copiadas ni Set de exclusivas propio', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli.match(/baseTools\(\{/g)?.length).toBe(2);
    expect(cli).toContain('MACHINE_TOOLS.has(tool.name)');
    expect(cli).not.toMatch(/const exclusive = new Set\(/);
  });
});
