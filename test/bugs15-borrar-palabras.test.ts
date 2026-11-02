import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BORRAR_SUB, runCronCommand } from '../src/daemon/cron-command.js';
import { Store } from '../src/db.js';
import { RoutineRunner } from '../src/routines.js';

// «/cron borrar resumen» enseñaba la lista y no borraba nada (solo valían del/borra/rm);
// «/disparador borrar 2» daba el error de cómo crear uno. /recordatorios ya usa «borrar».
describe('borrar rutinas y disparadores con la palabra de siempre', () => {
  const CHAT = 'telegram:42';
  const THREAD = `${CHAT}#main`;
  let dir = '';
  let store: Store;
  let runner: RoutineRunner;
  const deps = () => ({ store, routineRunner: runner, threadKey: THREAD, chatKey: CHAT });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-bugs15-borrar-'));
    store = new Store(join(dir, 'db.sqlite'));
    runner = new RoutineRunner({ store, run: async () => {}, timeoutMs: 5_000 });
    runner.start();
  });
  afterEach(() => {
    runner.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const word of ['borrar', 'Borrar', 'quita', 'quitar', 'elimina', 'eliminar']) {
    it(`/cron ${word} resumen borra la rutina`, () => {
      store.saveRoutine({
        scope: THREAD,
        name: 'resumen',
        kind: 'schedule',
        prompt: 'resumen del día',
        schedule: '0 8 * * *',
      });
      runCronCommand(deps(), `${word} resumen`);
      expect(store.getRoutine(THREAD, 'resumen')).toBeNull();
    });
  }

  it('las de antes siguen valiendo, y «pausar» pausa', () => {
    for (const w of ['del', 'borra', 'rm', 'borrar', 'quita', 'elimina'])
      expect(BORRAR_SUB.test(w)).toBe(true);
    for (const w of ['resumen', 'borrado', 'pausa']) expect(BORRAR_SUB.test(w)).toBe(false);
    store.saveRoutine({
      scope: THREAD,
      name: 'resumen',
      kind: 'schedule',
      prompt: 'resumen del día',
      schedule: '0 8 * * *',
    });
    runCronCommand(deps(), 'pausar resumen');
    expect(store.getRoutine(THREAD, 'resumen')?.enabled).toBe(false);
  });

  it('/disparador usa las mismas palabras para borrar', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    const body = cli.slice(
      cli.indexOf('const cmdTrigger = async'),
      cli.indexOf('const parsed = parseTriggerAdd(args.trim());'),
    );
    expect(body).toContain('if (BORRAR_SUB.test(sub)) {');
  });
});
