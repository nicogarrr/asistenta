// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que paths.ts cargue
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { PlaybookStore } from '../src/gestor/playbooks.js';
import { GestorStore } from '../src/gestor/store.js';
import { GoalStore } from '../src/goals/store.js';
import { createGestionTool } from '../src/tools/gestion.js';
import { createGoalTool } from '../src/tools/goal.js';

afterAll(() => {
  rmSync(FACTORY_TEST_STATE_DIR, { recursive: true, force: true });
});

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SCOPE = 'telegram:test:123#main';
const NOTE = `${'n'.repeat(199)}🎉 hecho`;

// asis-bugs-20: la nota de un paso (objetivo avance y gestion paso) se cortaba a 200
// unidades UTF-16 a ciegas; un emoji en el corte dejaba medio carácter en el plan.
describe('pasos de objetivos y gestiones: nota larga sin medio emoji', () => {
  it('objetivo avance', async () => {
    const goals = new GoalStore({ db: new DatabaseSync(':memory:') });
    const goal = goals.propose({
      scope: SCOPE,
      title: 'mudanza',
      verbatim: 'organiza la mudanza',
      plan: [
        { text: 'pedir presupuestos', done: false },
        { text: 'elegir empresa', done: false },
      ],
      cadence: '20 * * * *',
    });
    const tool = createGoalTool({
      goals,
      scopeOf: () => SCOPE,
      store: { saveRoutine: () => ({}) as never, deleteRoutine: () => true },
      sync: () => {},
      workstreams: { create: () => 'w', update: () => {}, forget: () => {} },
      humanRepliedAfter: () => true,
    });
    const r = await tool.execute('c', {
      action: 'avance',
      id: goal.id,
      paso: 1,
      nota: NOTE,
    } as never);
    expect(r.isError).toBeFalsy();
    const note = goals.read(goal.id)?.plan[0]?.note ?? '';
    expect(note).toBe('n'.repeat(199));
    expect(note).not.toMatch(LONE);
  });

  it('gestion paso', async () => {
    const gestor = new GestorStore({ db: new DatabaseSync(':memory:') });
    const g = gestor.propose({
      scope: SCOPE,
      title: 'renovar DNI',
      encargo: 'renueva el DNI',
      plan: [{ text: 'pedir cita', done: false } as never, { text: 'ir', done: false } as never],
    });
    gestor.start(g.id);
    const tool = createGestionTool({
      gestor,
      scopeOf: () => SCOPE,
      playbooks: new PlaybookStore({ dir: mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'bugs20-')) }),
      routines: { getRoutine: () => null },
    });
    const r = await tool.execute('c', { action: 'paso', id: g.id, paso: 1, nota: NOTE } as never);
    expect(r.isError).toBeFalsy();
    const after = gestor.read(g.id);
    expect(after?.plan[0]?.note).toBe('n'.repeat(199));
    expect(after?.ledger[0]?.note).not.toMatch(LONE);
  });
});
