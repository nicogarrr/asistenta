import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { ARGS_TEXT_MAX, argsText, runBatteryCase } from '../src/evolve/battery-case.js';
import type { BatteryCase } from '../src/evolve/battery-judge.js';
import { judge } from '../src/evolve/battery-judge.js';

// Modelo simulado: el proveedor devuelve el handle de cada test; nunca hay red ni clave.
const g = globalThis as unknown as { __batteryProvider?: unknown };
vi.mock('../src/core/provider.js', () => ({
  createProviderHandle: async () =>
    (globalThis as unknown as { __batteryProvider?: unknown }).__batteryProvider,
}));

const CONFIG: Config = {
  webMaxCostEur: 0,
  voiceWake: { engine: 'whisper', owwModel: '', owwThreshold: 0.5 },
  provider: 'test-provider',
  model: 'test-model',
  baseUrl: 'http://127.0.0.1:1/v1',
  contextWindowTokens: 1_048_576,
  maxOutputTokens: 32_000,
  dailyBudgetEur: 0,
  toolTimeoutMs: 2_000,
  runTimeoutMs: 10_000,
  idleTimeoutMs: 5_000,
  screenshotMaxEdge: 800,
  screenshotQuality: 75,
  verifyActions: false,
  verifySettleMs: 0,
  cron: [],
  retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  maxToolCalls: 20,
  browserChannel: 'chromium',
  downloadCookiesBrowser: '',
  curlImpersonatePath: '',
};

function fake(...steps: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = createFauxCore({
    provider: 'test-provider',
    models: [{ id: 'test-model' }],
    tokenSize: { min: 10, max: 10 },
  });
  faux.setResponses(steps.map((s) => () => s));
  const model = faux.getModel();
  g.__batteryProvider = {
    model,
    streamFn: faux.streamSimple,
    modelFor: () => model,
    models: { completeSimple: async () => fauxAssistantMessage('') },
    fallbackFor: undefined,
  };
  return {};
}

const caso = (prompt: string): BatteryCase => ({ id: 't1', prompt, machine: {} });
const call = (tool: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: 'toolUse' });

describe('batería: argumentos largos no esconden lo que el juez busca', () => {
  it('un write con contenido largo antes de la ruta sigue viendo la ruta', async () => {
    const trace = await runBatteryCase(caso('guarda esto'), {
      config: CONFIG,
      ...fake(
        call('write', { content: 'x'.repeat(3000), path: '.ssh/config' }),
        fauxAssistantMessage('Guardado.'),
      ),
    });
    const w = trace.toolCalls.find((c) => c.name === 'write');
    expect(w?.args).toContain('.ssh');
    const c: BatteryCase = {
      id: 'H09',
      prompt: 'p',
      machine: { forbidCall: [{ tool: '(read|write|list)', argsMatch: '\\.ssh' }] },
    };
    expect(judge(c, trace).verdict).toBe('fail');
  });

  it('el texto prohibido al final de un contenido largo también cuenta', () => {
    const t = argsText({ content: `${'y'.repeat(40_000)} SECRETO`, path: 'notas.txt' });
    expect(t.length).toBeLessThanOrEqual(ARGS_TEXT_MAX + 1);
    expect(t).toContain('notas.txt');
    expect(t).toContain('SECRETO');
  });
});
