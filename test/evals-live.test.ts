import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { afterAll, describe, expect, it } from 'vitest';
import { BATTERY } from '../src/evals/battery.js';
import type { EvalRun, EvalTask } from '../src/evals/harness.js';

/**
 * La eval en vivo no debe tocar la red ni el estado real del usuario. El
 * directorio se fija ANTES de importar el modulo porque `paths.ts` lo captura
 * al cargarse, igual que hace budget.test.ts.
 */
const stateDir = mkdtempSync(join(tmpdir(), 'pa-evals-live-'));
const previousStateDir = process.env.PA_STATE_DIR;
process.env.PA_STATE_DIR = stateDir;

const { LIVE_SCRIPTS, runLiveEval, runLiveEvalCli } = await import('../src/evals/live.js');

afterAll(() => {
  if (previousStateDir === undefined) delete process.env.PA_STATE_DIR;
  else process.env.PA_STATE_DIR = previousStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

const MODEL: Model<'openai-completions'> = {
  id: 'eval-live-test',
  name: 'eval-live-test',
  api: 'openai-completions',
  provider: 'eval-live-test',
  baseUrl: 'http://127.0.0.1:9/v1',
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  contextWindow: 100_000,
  maxTokens: 1_000,
};

function captureCheck(task: EvalTask, capture: { run?: EvalRun }): EvalTask {
  return {
    ...task,
    check: (run) => {
      capture.run = run;
      return task.check(run);
    },
  };
}

function taskById(id: string): EvalTask {
  const task = BATTERY.find((item) => item.id === id);
  if (!task) throw new Error(`la bateria no tiene la tarea ${id}`);
  return task;
}

describe('runLiveEval sin red', () => {
  it('ejecuta las 6 primeras tareas con los guiones y sin llamar a fetch', async () => {
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (() => {
      fetchCalls++;
      return Promise.reject(new Error('la eval no puede usar la red'));
    }) as typeof globalThis.fetch;
    try {
      const report = await runLiveEval({ model: MODEL, stateDir: join(stateDir, 'seis') });
      expect(report.failed).toBe(0);
      expect(report.passed).toBe(6);
      expect(report.results.map((result) => result.id)).toEqual(
        BATTERY.slice(0, 6).map((task) => task.id),
      );
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  }, 30_000);

  it('cambiar un guion hace fallar su tarea con el detalle del check', async () => {
    const script = LIVE_SCRIPTS.find((item) =>
      item.match.test('recuerda que soy alérgico a los frutos secos'),
    );
    if (!script) throw new Error('falta el guion de la alergia');
    const original = structuredClone(script.steps);
    script.steps = [
      {
        calls: [
          {
            name: 'memory',
            args: { action: 'remember', text: 'El usuario no tiene ninguna alergia.' },
          },
        ],
      },
    ];
    const capture: { run?: EvalRun } = {};
    try {
      const report = await runLiveEval(
        { model: MODEL, stateDir: join(stateDir, 'guion-cambiado') },
        [captureCheck(taskById('memoria-alergia'), capture)],
      );
      expect(report.failed).toBe(1);
      expect(report.results[0]?.detail).toContain('no guardó la alergia');
      expect(capture.run?.memory).toContain('El usuario no tiene ninguna alergia.');
    } finally {
      script.steps = original;
    }
  }, 30_000);

  it('el caso bloqueado no ejecuta la tool y rellena blocked', async () => {
    const executed: string[] = [];
    const shellParams = Type.Object({ command: Type.Optional(Type.String()) });
    const shell: AgentTool<typeof shellParams> = {
      name: 'shell',
      label: 'Shell',
      description: 'espia de shell: si se ejecuta, se nota',
      parameters: shellParams,
      execute: async (_id, args) => {
        executed.push(args.command ?? '');
        return { content: [{ type: 'text', text: 'no deberia ejecutarse' }], details: {} };
      },
    };
    const capture: { run?: EvalRun } = {};
    const report = await runLiveEval(
      { model: MODEL, tools: [shell], stateDir: join(stateDir, 'bloqueado') },
      [captureCheck(taskById('seguridad-borrado'), capture)],
    );

    expect(report.passed).toBe(1);
    expect(executed).toEqual([]);
    expect(capture.run?.blocked.length).toBeGreaterThan(0);
    expect(capture.run?.blocked.join(' ')).toContain('shell');
    expect(capture.run?.tools).not.toContain('shell');
  }, 30_000);

  it('sin guion devuelve un run vacio y falla con detalle "sin guion"', async () => {
    const sinGuion: EvalTask = {
      id: 'sin-guion',
      category: 'herramientas',
      prompt: 'haz una cosa que no tiene guion',
      check: () => ({ ok: true }),
    };
    const report = await runLiveEval({ model: MODEL, stateDir: join(stateDir, 'sin-guion') }, [
      sinGuion,
    ]);
    expect(report.failed).toBe(1);
    expect(report.results).toEqual([{ id: 'sin-guion', ok: false, detail: 'sin guion' }]);
  }, 30_000);

  it('runLiveEvalCli devuelve 0 con toda la bateria guionizada', async () => {
    await expect(runLiveEvalCli(['--min-global=0.8'])).resolves.toBe(0);
  }, 60_000);
});
