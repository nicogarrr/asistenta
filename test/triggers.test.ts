import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/db.js';
import {
  buildTriggerPrompt,
  formatTriggerList,
  matchesTrigger,
  parseTriggerAdd,
  TriggerEngine,
  triggerScopeMatches,
} from '../src/triggers.js';

let dir: string;
let store: Store;

const SCOPE = 'chat:telegram:42#main';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'trig-'));
  store = new Store(join(dir, 'db.sqlite'));
});

// The store has to be closed before the directory goes (WAL + Windows EBUSY).
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function saveProcedure(name = 'archiva-pdf') {
  return store.saveRoutine({
    scope: SCOPE,
    name,
    kind: 'procedure',
    steps: 'Mueve el archivo a su carpeta.',
  });
}

describe('trigger store', () => {
  it('guarda, lista, marca y borra disparadores', () => {
    saveProcedure();
    const t = store.saveTrigger({
      scope: SCOPE,
      routine: 'archiva-pdf',
      event: 'archivo',
      match: '.pdf',
      cooldownSeconds: 60,
    });
    expect(t.enabled).toBe(true);
    expect(t.lastFiredAt).toBeNull();
    expect(store.listTriggers(SCOPE)).toHaveLength(1);
    store.markTriggerFired(t.id, '2026-10-19T01:00:00.000Z');
    expect(store.getTrigger(t.id)?.lastFiredAt).toBe('2026-10-19T01:00:00.000Z');
    expect(store.deleteTrigger(t.id)).toBe(true);
    expect(store.listTriggers()).toHaveLength(0);
  });

  it('es idempotente: mismo scope/rutina/evento/coincidencia actualiza, no duplica', () => {
    saveProcedure();
    const a = store.saveTrigger({
      scope: SCOPE,
      routine: 'archiva-pdf',
      event: 'archivo',
      match: '.pdf',
    });
    const b = store.saveTrigger({
      scope: SCOPE,
      routine: 'archiva-pdf',
      event: 'archivo',
      match: '.pdf',
      cooldownSeconds: 10,
    });
    expect(b.id).toBe(a.id);
    expect(b.cooldownSeconds).toBe(10);
    expect(store.listTriggers()).toHaveLength(1);
  });

  it('rechaza disparadores sin evento, coincidencia o rutina', () => {
    expect(() =>
      store.saveTrigger({ scope: SCOPE, routine: 'x', event: ' ', match: 'y' }),
    ).toThrow();
    expect(() =>
      store.saveTrigger({ scope: SCOPE, routine: 'x', event: 'archivo', match: ' ' }),
    ).toThrow();
    expect(() =>
      store.saveTrigger({ scope: SCOPE, routine: ' ', event: 'archivo', match: 'y' }),
    ).toThrow();
  });
});

describe('matching', () => {
  it('un evento de chat solo dispara triggers de ese chat; uno global, todos', () => {
    expect(triggerScopeMatches('chat:telegram:42#main', 'chat:telegram:42')).toBe(true);
    expect(triggerScopeMatches('chat:telegram:42#main', '')).toBe(true);
    expect(triggerScopeMatches('chat:telegram:42#main', 'chat:telegram:99')).toBe(false);
    expect(triggerScopeMatches('chat:telegram:99#main', 'chat:telegram:42')).toBe(false);
  });

  it('coincide sin distinguir mayúsculas y respeta tipo y enabled', () => {
    saveProcedure();
    const t = store.saveTrigger({
      scope: SCOPE,
      routine: 'archiva-pdf',
      event: 'mensaje',
      match: 'Factura',
    });
    expect(
      matchesTrigger(t, {
        type: 'mensaje',
        scope: 'chat:telegram:42',
        text: 'llegó la FACTURA de la luz',
      }),
    ).toBe(true);
    expect(matchesTrigger(t, { type: 'mensaje', scope: 'chat:telegram:42', text: 'hola' })).toBe(
      false,
    );
    expect(matchesTrigger(t, { type: 'archivo', scope: '', text: 'factura.pdf' })).toBe(false);
    expect(
      matchesTrigger(
        { ...t, enabled: false },
        { type: 'mensaje', scope: 'chat:telegram:42', text: 'factura' },
      ),
    ).toBe(false);
  });
});

describe('parseTriggerAdd', () => {
  it('parsea tipo, coincidencia, rutina y args de macro', () => {
    const r = parseTriggerAdd('archivo .pdf | macro/archiva fichero=documentos');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      event: 'archivo',
      match: '.pdf',
      routine: 'macro/archiva',
      args: { fichero: 'documentos' },
    });
  });

  it('rechaza formas rotas con un mensaje claro', () => {
    expect(parseTriggerAdd('archivo .pdf').ok).toBe(false);
    expect(parseTriggerAdd('humo x | y').ok).toBe(false);
    expect(parseTriggerAdd('archivo | rutina').ok).toBe(false);
    expect(parseTriggerAdd('archivo .pdf | rutina suelto').ok).toBe(false);
  });
});

describe('buildTriggerPrompt', () => {
  it('una macro sin argumentos fijos no dispara: error claro', () => {
    store.saveRoutine({
      scope: SCOPE,
      name: 'macro/archiva',
      kind: 'procedure',
      steps: 'Mueve {fichero} a su carpeta.',
      params: [{ name: 'fichero', type: 'texto' }],
    });
    const routine = store.getRoutine(SCOPE, 'macro/archiva');
    expect(routine).not.toBeNull();
    if (!routine) return;
    const bad = buildTriggerPrompt(routine, {
      id: '',
      scope: SCOPE,
      routine: routine.name,
      event: 'archivo',
      match: '.pdf',
      args: null,
      enabled: true,
      cooldownSeconds: 0,
      lastFiredAt: null,
      createdAt: '',
    });
    expect(bad.ok).toBe(false);
    const good = buildTriggerPrompt(routine, {
      id: '',
      scope: SCOPE,
      routine: routine.name,
      event: 'archivo',
      match: '.pdf',
      args: { fichero: 'documentos' },
      enabled: true,
      cooldownSeconds: 0,
      lastFiredAt: null,
      createdAt: '',
    });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.prompt).toContain('documentos');
  });
});

describe('TriggerEngine', () => {
  it('dispara la rutina por el camino compartido y marca el disparo', async () => {
    saveProcedure();
    store.saveTrigger({ scope: SCOPE, routine: 'archiva-pdf', event: 'archivo', match: '.pdf' });
    const fired: string[] = [];
    const engine = new TriggerEngine({
      store,
      run: async (prompt) => {
        fired.push(prompt);
      },
    });
    const r = await engine.emit({ type: 'archivo', scope: '', text: 'factura-enero.pdf' });
    expect(r).toEqual({ matched: 1, fired: 1, skipped: 0 });
    expect(fired).toHaveLength(1);
    expect(fired[0]).toContain('archiva-pdf');
    expect(store.listTriggers()[0]?.lastFiredAt).not.toBeNull();
  });

  it('el cooldown frena una tormenta de eventos', async () => {
    saveProcedure();
    store.saveTrigger({
      scope: SCOPE,
      routine: 'archiva-pdf',
      event: 'archivo',
      match: '.pdf',
      cooldownSeconds: 300,
    });
    let now = 1_000_000;
    let n = 0;
    const engine = new TriggerEngine({
      store,
      now: () => now,
      run: async () => {
        n++;
      },
    });
    await engine.emit({ type: 'archivo', scope: '', text: 'a.pdf' });
    await engine.emit({ type: 'archivo', scope: '', text: 'b.pdf' });
    now += 301_000;
    await engine.emit({ type: 'archivo', scope: '', text: 'c.pdf' });
    expect(n).toBe(2);
  });

  it('una rutina huérfana o rota no tira el reparto ni tapona a las demás', async () => {
    saveProcedure();
    saveProcedure('otra');
    store.saveTrigger({ scope: SCOPE, routine: 'no-existe', event: 'archivo', match: '.pdf' });
    store.saveTrigger({ scope: SCOPE, routine: 'otra', event: 'archivo', match: '.pdf' });
    const fired: string[] = [];
    const engine = new TriggerEngine({
      store,
      run: async (prompt) => {
        fired.push(prompt);
      },
    });
    const r = await engine.emit({ type: 'archivo', scope: '', text: 'x.pdf' });
    expect(r).toEqual({ matched: 2, fired: 1, skipped: 1 });
    expect(fired).toHaveLength(1);
  });

  it('un fallo al entregar no rompe el resto de disparos', async () => {
    saveProcedure();
    saveProcedure('otra');
    store.saveTrigger({
      scope: SCOPE,
      routine: 'archiva-pdf',
      event: 'mensaje',
      match: 'factura',
      cooldownSeconds: 0,
    });
    store.saveTrigger({
      scope: SCOPE,
      routine: 'otra',
      event: 'mensaje',
      match: 'factura',
      cooldownSeconds: 0,
    });
    let calls = 0;
    const engine = new TriggerEngine({
      store,
      run: async () => {
        calls++;
        if (calls === 1) throw new Error('telegram caído');
      },
    });
    const r = await engine.emit({ type: 'mensaje', scope: 'chat:telegram:42', text: 'factura' });
    expect(r.matched).toBe(2);
    expect(r.fired).toBe(1);
    expect(r.skipped).toBe(1);
  });
});

describe('formatTriggerList', () => {
  it('lista numerada y mensaje de vacío', () => {
    expect(formatTriggerList([])).toMatch(/No hay disparadores/);
    saveProcedure();
    store.saveTrigger({ scope: SCOPE, routine: 'archiva-pdf', event: 'archivo', match: '.pdf' });
    const text = formatTriggerList(store.listTriggers(SCOPE));
    expect(text).toContain('1. [archivo] ".pdf" → archiva-pdf');
  });
});
