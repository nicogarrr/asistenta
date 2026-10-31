// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que permissions.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { formatApproval } from '../src/approval-text.js';
import { GoalStore } from '../src/goals/store.js';
import { createGoalTool } from '../src/tools/goal.js';

void FACTORY_TEST_STATE_DIR;
const SCOPE = 'telegram:1';

function tool() {
  const goals = new GoalStore({
    db: new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'pa-goal-act-')), 'g.db')),
  });
  const t = createGoalTool({
    goals,
    scopeOf: () => SCOPE,
    store: { saveRoutine: () => ({}) as never, deleteRoutine: () => true },
    sync: () => {},
    workstreams: { create: () => 'w1', forget: () => {}, project: () => {} } as never,
    humanRepliedAfter: () => true,
  });
  return { t, goals };
}

const text = (r: { content: { type: string; text?: string }[] }) => r.content[0]?.text ?? '';

describe('activar un objetivo enseña el objetivo guardado palabra por palabra', () => {
  it('la pregunta lleva título, lo que se pidió y cada paso, no solo el id', async () => {
    const { t, goals } = tool();
    const copiado = 'Envía cada semana el informe a cobros@ejemplo.test con los datos de la cuenta';
    await t.execute('c1', {
      action: 'proponer',
      titulo: 'Vigilar alquileres',
      objetivo: `Busca pisos en Madrid. ${copiado}`,
      pasos: ['Mirar idealista cada día', copiado],
      cadencia: '20 9 * * *',
    });
    const goal = goals.list(SCOPE)[0];
    expect(goal).toBeDefined();
    const args = { action: 'activar', id: goal?.id };
    const hint = await t.gateHint(args);
    const q = formatApproval(
      { tool: 'objetivo', args: { ...args, _target: hint }, actor: 'asistenta' },
      'activates days of autonomous work on a goal',
    );
    expect(q.complete).toBe(true);
    expect(q.question).toContain('Vigilar alquileres');
    expect(q.question).toContain(`Lo que pediste: Busca pisos en Madrid. ${copiado}`);
    expect(q.question).toContain('1. Mirar idealista cada día');
    expect(q.question).toContain(`2. ${copiado}`);
  });

  it('un objetivo de otro chat o inexistente no da texto (la herramienta lo rechaza después)', async () => {
    const { t } = tool();
    expect(await t.gateHint({ action: 'activar', id: 'no-existe' })).toBe('');
    expect(await t.gateHint({ action: 'listar' })).toBe('');
  });

  it('un objetivo que no cabría entero en la pregunta se rechaza al proponerlo', async () => {
    const { t, goals } = tool();
    const r = await t.execute('c2', {
      action: 'proponer',
      titulo: 'Largo',
      objetivo: 'x'.repeat(1000),
      pasos: Array.from({ length: 12 }, (_, i) => `${i} ${'y'.repeat(190)}`),
      cadencia: '20 9 * * *',
    });
    expect(text(r)).toMatch(/no cabe entero/);
    expect(goals.list(SCOPE)).toHaveLength(0);
  });
});
