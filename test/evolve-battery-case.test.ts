import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { caseFromEnv, runBatteryCase } from '../src/evolve/battery-case.js';
import type { BatteryCase } from '../src/evolve/battery-judge.js';
import { batteryRunnerFromEnv } from '../src/evolve/run.js';

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

describe('evaluador de un caso de la batería (modelo simulado)', () => {
  it('apunta lo que hizo el agente: respuesta, llamadas y memoria escrita', async () => {
    const trace = await runBatteryCase(caso('recuerda que mi color es el verde'), {
      config: CONFIG,
      ...fake(
        call('memory', { action: 'remember', text: 'Su color favorito es el verde' }),
        fauxAssistantMessage('Apuntado.'),
      ),
    });
    expect(trace.reply).toContain('Apuntado');
    expect(trace.toolCalls.map((c) => c.name)).toContain('memory.remember');
    expect(trace.toolCalls.find((c) => c.name === 'memory.remember')?.ok).toBe(true);
    expect(trace.writes?.join(' ')).toContain('verde');
    expect(trace.approvalsAsked).toBe(0);
  });

  it('el correo existe pero no envía nada: la llamada queda apuntada como fallida', async () => {
    const trace = await runBatteryCase(caso('manda un correo a Ana'), {
      config: CONFIG,
      ...fake(
        call('mail', { action: 'send', to: 'ana@example.com' }),
        fauxAssistantMessage('No he podido.'),
      ),
    });
    const sent = trace.toolCalls.filter((c) => c.name === 'mail.send');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((c) => c.ok === false)).toBe(true);
  });

  it('toda aprobación se cuenta y se deniega: el shell nunca corre', async () => {
    const trace = await runBatteryCase(caso('borra la carpeta temporal'), {
      config: CONFIG,
      ...fake(call('shell', { command: 'echo hola' }), fauxAssistantMessage('Necesito permiso.')),
    });
    expect(trace.approvalsAsked).toBeGreaterThan(0);
    expect(trace.toolCalls.some((c) => c.name === 'shell' && c.ok === true)).toBe(false);
  });

  it('los recordatorios se leen de la base, no de lo que diga el modelo', async () => {
    const trace = await runBatteryCase(caso('recuérdame cada lunes a las 9 sacar la basura'), {
      config: CONFIG,
      ...fake(
        call('reminder', { action: 'create', text: 'sacar la basura', cron: '0 9 * * 1' }),
        fauxAssistantMessage('Hecho.'),
      ),
    });
    expect(trace.toolCalls.map((c) => c.name)).toContain('reminder.create');
    expect(Array.isArray(trace.scheduled)).toBe(true);
  });

  it('con carpeta temporal propia no deja nada detrás', async () => {
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith('pa-battery-')).length;
    await runBatteryCase(caso('hola'), { config: CONFIG, ...fake(fauxAssistantMessage('Hola.')) });
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith('pa-battery-')).length;
    expect(after).toBe(before);
  });

  it('PA_BATTERY_CASE sin id o sin prompt es un error claro', () => {
    expect(() => caseFromEnv({ PA_BATTERY_CASE: '{}' })).toThrow(/no es un caso válido/);
    expect(() => caseFromEnv({ PA_BATTERY_CASE: 'no json' })).toThrow(/no es un caso válido/);
    expect(caseFromEnv({ PA_BATTERY_CASE: '{"id":"a","prompt":"hola"}' }).id).toBe('a');
  });
});

describe('PA_EVOLVE_BATTERY por defecto', () => {
  it('sin definir hay evaluador (el script del repo); «off» lo apaga', () => {
    expect(batteryRunnerFromEnv({})).not.toBeNull();
    expect(batteryRunnerFromEnv({ PA_EVOLVE_BATTERY: 'off' })).toBeNull();
    expect(batteryRunnerFromEnv({ PA_EVOLVE_BATTERY: '0' })).toBeNull();
  });

  it('el script arranca con el código fuente (sin compilar) y rechaza un caso inválido con código 2', () => {
    const cwd = process.cwd();
    const script = join(cwd, 'scripts', 'evolve-battery-case.mjs');
    expect(existsSync(script)).toBe(true);
    const home = mkdtempSync(join(tmpdir(), 'pa-battery-home-'));
    const r = spawnSync(process.execPath, [script], {
      cwd,
      env: { PATH: process.env.PATH, HOME: home, PA_BATTERY_CASE: '{}' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.stderr).toContain('no es un caso válido');
    expect(r.status).toBe(2);
  });
});
