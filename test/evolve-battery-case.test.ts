import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

  it('la web existe pero no sale a la red: la llamada queda apuntada como fallida', async () => {
    const trace = await runBatteryCase(caso('busca el tiempo en Madrid'), {
      config: CONFIG,
      ...fake(
        call('web', { action: 'search', query: 'tiempo Madrid' }),
        fauxAssistantMessage('No he podido.'),
      ),
    });
    const sent = trace.toolCalls.filter((c) => c.name === 'web.search');
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

  it('B23: write y read funcionan dentro de la carpeta temporal, sin aprobación', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-battery-ws-'));
    fake(
      call('write', { path: 'pruebas/hola.txt', content: 'hola' }),
      call('read', { path: 'pruebas/hola.txt' }),
      call('list', { path: 'pruebas' }),
      call('write', { path: '../fuera.txt', content: 'x' }),
      fauxAssistantMessage('Pone: hola'),
    );
    const t = await runBatteryCase(caso('Crea pruebas/hola.txt con hola y léemelo'), {
      config: CONFIG,
      stateDir: dir,
    });
    expect(t.toolCalls.map((c) => [c.name, c.ok])).toEqual([
      ['write', true],
      ['read', true],
      ['list', true],
      ['write', false],
    ]);
    expect(t.approvalsAsked).toBe(0);
    expect(readFileSync(join(dir, 'espacio', 'pruebas', 'hola.txt'), 'utf8')).toBe('hola');
    expect(existsSync(join(dir, 'fuera.txt'))).toBe(false);
  });

  it('con carpeta temporal propia no deja nada detrás (aunque otro test cree pa-battery-* a la vez)', async () => {
    // tmpdir() compartido: otros ficheros de test crean pa-battery-* en paralelo y
    // contar ahí fallaba al azar en CI. Se cuenta en una carpeta privada (TMPDIR).
    const own = mkdtempSync(join(tmpdir(), 'pa-bc-own-'));
    const shared = tmpdir();
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = own;
    let foreign = '';
    try {
      const run = runBatteryCase(caso('hola'), {
        config: CONFIG,
        ...fake(fauxAssistantMessage('Hola.')),
      });
      foreign = mkdtempSync(join(shared, 'pa-battery-')); // «otro test» a la vez
      await run;
      expect(readdirSync(own).filter((f) => f.startsWith('pa-battery-'))).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
      if (foreign) rmSync(foreign, { recursive: true, force: true });
      rmSync(own, { recursive: true, force: true });
    }
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

  it('el script valida el caso ANTES de cargar el asistente (un caso inválido responde rápido aunque la máquina vaya cargada)', () => {
    // Copia mínima: el asistente (battery-case.ts) revienta si se carga; solo está el lector del caso.
    const repo = process.cwd();
    const cwd = mkdtempSync(join(tmpdir(), 'pa-battery-cwd-'));
    mkdirSync(join(cwd, 'src', 'evolve'), { recursive: true });
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(cwd, 'src', 'evolve', 'battery-case.ts'),
      "throw new Error('asistente cargado antes de validar el caso');\n",
    );
    const env = join(repo, 'src', 'evolve', 'battery-case-env.ts');
    if (existsSync(env)) copyFileSync(env, join(cwd, 'src', 'evolve', 'battery-case-env.ts'));
    const home = mkdtempSync(join(tmpdir(), 'pa-battery-home-'));
    const r = spawnSync(process.execPath, [join(repo, 'scripts', 'evolve-battery-case.mjs')], {
      cwd,
      env: { PATH: process.env.PATH, HOME: home, PA_BATTERY_CASE: '{}' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.stderr).not.toContain('asistente cargado');
    expect(r.stderr).toContain('no es un caso válido');
    expect(r.status).toBe(2);
  });
});
