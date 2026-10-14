// FIRST import statement, always - before ANYTHING that transitively loads
// paths.ts: it assigns PA_STATE_DIR (fresh mkdtemp per run) before paths.ts
// can snapshot the real state dir.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que permissions.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { PlaybookStore } from '../src/gestor/playbooks.js';
import { GestorStore } from '../src/gestor/store.js';
import { createGestionTool } from '../src/tools/gestion.js';

const SCOPE = 'telegram:test:123#main';

function newDb(): DatabaseSync {
  return new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'pa-pbm-')), 'g.db'));
}

function activeGestion(gestor: GestorStore) {
  const g = gestor.propose({
    scope: SCOPE,
    title: 'alta',
    encargo: 'hazme el alta',
    plan: [{ text: 'paso 1', effect: 'lee', done: false }],
  });
  gestor.start(g.id);
  return g;
}

describe('GestorStore playbook outcomes (C3)', () => {
  it('complete counts ok per declared domain WITH a playbook, and only those', () => {
    const gestor = new GestorStore({ db: newDb() });
    const g = activeGestion(gestor);
    gestor.noteDomains(g.id, [
      { domain: 'seg-social.es', hadPlaybook: true },
      { domain: 'sin-playbook.es', hadPlaybook: false },
    ]);
    gestor.complete(g.id);
    expect(gestor.playbookOutcomes()).toEqual([{ domain: 'seg-social.es', ok: 1, failed: 0 }]);
  });

  it('cancel counts "no completada" only when the gestión was attempted (active)', () => {
    const gestor = new GestorStore({ db: newDb() });
    const attempted = activeGestion(gestor);
    gestor.noteDomains(attempted.id, [{ domain: 'intentada.es', hadPlaybook: true }]);
    gestor.cancel(attempted.id);
    const proposed = gestor.propose({
      scope: SCOPE,
      title: 'x',
      encargo: 'y',
      plan: [{ text: 'paso 1', effect: 'lee', done: false }],
    });
    gestor.noteDomains(proposed.id, [{ domain: 'solo-propuesta.es', hadPlaybook: true }]);
    gestor.cancel(proposed.id);
    expect(gestor.playbookOutcomes()).toEqual([{ domain: 'intentada.es', ok: 0, failed: 1 }]);
  });

  it('attribution is consumed once: a later gestión starts clean', () => {
    const gestor = new GestorStore({ db: newDb() });
    const g1 = activeGestion(gestor);
    gestor.noteDomains(g1.id, [{ domain: 'a.es', hadPlaybook: true }]);
    gestor.complete(g1.id);
    const g2 = activeGestion(gestor);
    gestor.complete(g2.id);
    expect(gestor.playbookOutcomes()).toEqual([{ domain: 'a.es', ok: 1, failed: 0 }]);
  });

  it('outcomes aggregate across gestiones of the same domain', () => {
    const gestor = new GestorStore({ db: newDb() });
    const g1 = activeGestion(gestor);
    gestor.noteDomains(g1.id, [{ domain: 'a.es', hadPlaybook: true }]);
    gestor.complete(g1.id);
    const g2 = activeGestion(gestor);
    gestor.noteDomains(g2.id, [{ domain: 'a.es', hadPlaybook: true }]);
    gestor.cancel(g2.id);
    expect(gestor.playbookOutcomes()).toEqual([{ domain: 'a.es', ok: 1, failed: 1 }]);
  });
});

describe('gestion tool: preparar records the attribution (C3)', () => {
  function setup() {
    const gestor = new GestorStore({ db: newDb() });
    const playbooks = new PlaybookStore({
      dir: mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'pb-')),
    });
    const tool = createGestionTool({
      gestor,
      scopeOf: () => SCOPE,
      playbooks,
      routines: { getRoutine: () => null },
      vaultNames: async () => [],
    });
    const run = (args: Record<string, unknown>) => tool.execute('c', args as never);
    return { gestor, playbooks, run };
  }

  const fullRun = async (
    run: (a: Record<string, unknown>) => Promise<unknown>,
    gestor: GestorStore,
    logins: string[],
  ) => {
    await run({
      action: 'preparar',
      titulo: 'alta',
      encargo: 'hazme el alta',
      pasos: [{ texto: 'Abrir la web', efecto: 'lee' }],
      logins,
    });
    const [g] = gestor.list(SCOPE);
    if (!g) throw new Error('la gestión no quedó propuesta');
    await run({ action: 'ejecutar', id: g.id });
    await run({ action: 'paso', id: g.id, paso: 1 });
    await run({ action: 'completar', id: g.id });
  };

  it('completar increments ok for the domain whose playbook existed at plan time', async () => {
    const { gestor, playbooks, run } = setup();
    playbooks.save({
      domain: 'seg-social.es',
      updatedAt: new Date().toISOString(),
      login: ['usuario y clave en site:seg-social.es:usuario'],
      selectores: [],
      quirks: [],
    });
    await fullRun(run, gestor, ['seg-social.es']);
    expect(gestor.playbookOutcomes()).toEqual([{ domain: 'seg-social.es', ok: 1, failed: 0 }]);
  });

  it('a domain without playbook at plan time never enters the tally', async () => {
    const { gestor, run } = setup();
    await fullRun(run, gestor, ['sin-playbook.es']);
    expect(gestor.playbookOutcomes()).toEqual([]);
  });
});
