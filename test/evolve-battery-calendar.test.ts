import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { batteryCalendarTool, runBatteryCase } from '../src/evolve/battery-case.js';
import type { BatteryCase } from '../src/evolve/battery-judge.js';
import { BATTERY_CALL_KIND } from '../src/evolve/battery-judge.js';

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

describe('batería: el calendario real (solo lectura) está, sin red', () => {
  it('«agenda» funciona y queda apuntada como lectura', async () => {
    const trace = await runBatteryCase(caso('¿qué tengo esta semana?'), {
      config: CONFIG,
      ...fake(call('calendar', { action: 'agenda', days: 7 }), fauxAssistantMessage('Nada.')),
    });
    expect(trace.toolCalls.find((c) => c.name === 'calendar.agenda')?.ok).toBe(true);
    expect(BATTERY_CALL_KIND['calendar.agenda']).toBe('lee');
  });

  it('no puede crear eventos: solo existe «agenda»', async () => {
    const tool = batteryCalendarTool();
    await expect(tool.execute('x', { action: 'create' } as never)).rejects.toThrow();
    expect(tool.description).toContain('READ-ONLY');
  });
});
