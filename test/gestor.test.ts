// FIRST import statement, always - before ANYTHING that transitively loads
// paths.ts: it assigns PA_STATE_DIR (fresh mkdtemp per run) before paths.ts
// can snapshot the real state dir.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que permissions.js cargue paths.ts
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EFFECT_CLASSES, EFFECT_LABEL, effectCovered } from '../src/gestor/effects.js';
import {
  GestorStore,
  MAX_ACTIVE_GESTIONES_PER_SCOPE,
  MAX_PROPOSED_GESTIONES,
  type GestionStep,
  effectOverrideReason,
} from '../src/gestor/store.js';
import { Gate } from '../src/permissions.js';
import { MAX_GESTION_CHARS, createGestionTool, formatProposal } from '../src/tools/gestion.js';

const stateDir = FACTORY_TEST_STATE_DIR;

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const SCOPE = 'telegram:test:123#main';
const OTHER = 'telegram:test:999#main';

function newDb(): DatabaseSync {
  return new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'pa-gestor-')), 'g.db'));
}

function plan(
  ...effects: Array<'lee' | 'escribe-local' | 'envia-terceros' | 'paga' | 'destructivo'>
): GestionStep[] {
  return effects.map((effect, i) => ({ text: `paso ${i + 1}`, effect, done: false }));
}

function proposeIn(gestor: GestorStore, scope = SCOPE) {
  return gestor.propose({
    scope,
    title: 'alta en el portal',
    encargo: 'hazme el alta en el portal de citas, NO ENVIES nada sin decirmelo',
    plan: plan('lee', 'envia-terceros'),
  });
}

describe('GestorStore', () => {
  it('propose + read round-trips plan, ledger and currentStep', () => {
    const gestor = new GestorStore({ db: newDb() });
    const g = proposeIn(gestor);
    const back = gestor.read(g.id);
    expect(back?.status).toBe('proposed');
    expect(back?.plan).toHaveLength(2);
    expect(back?.plan[0]?.effect).toBe('lee');
    expect(back?.plan[1]?.effect).toBe('envia-terceros');
    expect(back?.currentStep).toBe(0);
    expect(back?.ledger).toEqual([]);
    expect(back?.encargo).toContain('NO ENVIES');
  });

  it('caps proposed gestiones per scope and not across scopes', () => {
    const gestor = new GestorStore({ db: newDb() });
    for (let i = 0; i < MAX_PROPOSED_GESTIONES; i++) proposeIn(gestor);
    expect(() => proposeIn(gestor)).toThrow(/propuestas esperando respuesta/);
    expect(() => proposeIn(gestor, OTHER)).not.toThrow();
  });

  it('start moves proposed -> active once', () => {
    const gestor = new GestorStore({ db: newDb() });
    const g = proposeIn(gestor);
    gestor.start(g.id);
    expect(gestor.read(g.id)?.status).toBe('active');
    expect(() => gestor.start(g.id)).toThrow(/Solo se ejecuta una gestión propuesta/);
  });

  it('allows at most one active gestion per scope', () => {
    const gestor = new GestorStore({ db: newDb() });
    const a = proposeIn(gestor);
    const b = proposeIn(gestor);
    gestor.start(a.id);
    expect(MAX_ACTIVE_GESTIONES_PER_SCOPE).toBe(1);
    expect(() => gestor.start(b.id)).toThrow(/Ya hay una gestión activa/);
    gestor.cancel(a.id);
    expect(() => gestor.start(b.id)).not.toThrow();
  });

  it('start works per scope: another chat can run its own', () => {
    const gestor = new GestorStore({ db: newDb() });
    const a = proposeIn(gestor);
    const b = proposeIn(gestor, OTHER);
    gestor.start(a.id);
    expect(() => gestor.start(b.id)).not.toThrow();
  });

  it('recordStep marks done, appends to the ledger and advances currentStep', () => {
    const gestor = new GestorStore({ db: newDb() });
    const g = proposeIn(gestor);
    gestor.start(g.id);
    gestor.recordStep(g.id, 0, 'portal localizado');
    const after = gestor.read(g.id);
    expect(after?.plan[0]?.done).toBe(true);
    expect(after?.plan[0]?.note).toBe('portal localizado');
    expect(after?.currentStep).toBe(1);
    expect(after?.ledger).toHaveLength(1);
    expect(after?.ledger[0]?.step).toBe(1);
    gestor.recordStep(g.id, 1, 'formulario enviado');
    const done = gestor.read(g.id);
    expect(done?.currentStep).toBe(2);
    expect(done?.ledger).toHaveLength(2);
  });

  it('recordStep rejects fractions, NaN, out-of-range and repeats', () => {
    const gestor = new GestorStore({ db: newDb() });
    const g = proposeIn(gestor);
    gestor.start(g.id);
    expect(() => gestor.recordStep(g.id, 0.5, 'x')).toThrow(/número entero/);
    expect(() => gestor.recordStep(g.id, Number.NaN, 'x')).toThrow(/número entero/);
    expect(() => gestor.recordStep(g.id, -1, 'x')).toThrow(/número entero/);
    expect(() => gestor.recordStep(g.id, 5, 'x')).toThrow(/número entero/);
    // Nothing was recorded by the rejected calls.
    expect(gestor.read(g.id)?.ledger).toEqual([]);
    gestor.recordStep(g.id, 0, 'ok');
    expect(() => gestor.recordStep(g.id, 0, 'otra vez')).toThrow(/ya estaba marcado/);
    expect(gestor.read(g.id)?.ledger).toHaveLength(1);
  });

  it('recordStep rejects a non-active gestion', () => {
    const gestor = new GestorStore({ db: newDb() });
    const g = proposeIn(gestor);
    expect(() => gestor.recordStep(g.id, 0, 'x')).toThrow(/Solo se avanza una gestión activa/);
  });

  it('complete requires active; cancel rejects done', () => {
    const gestor = new GestorStore({ db: newDb() });
    const g = proposeIn(gestor);
    expect(() => gestor.complete(g.id)).toThrow(/Solo se completa una gestión activa/);
    gestor.start(g.id);
    gestor.complete(g.id);
    expect(gestor.read(g.id)?.status).toBe('done');
    expect(() => gestor.cancel(g.id)).toThrow(/no se cancela/);
  });

  it('activeForScope returns the active one and null afterwards', () => {
    const gestor = new GestorStore({ db: newDb() });
    expect(gestor.activeForScope(SCOPE)).toBeNull();
    const g = proposeIn(gestor);
    expect(gestor.activeForScope(SCOPE)).toBeNull();
    gestor.start(g.id);
    expect(gestor.activeForScope(SCOPE)?.id).toBe(g.id);
    gestor.complete(g.id);
    expect(gestor.activeForScope(SCOPE)).toBeNull();
  });
});

describe('effect classes', () => {
  it('covers exactly the declared lattice: lee always, paga covers envia, nothing else crosses', () => {
    for (const step of EFFECT_CLASSES) {
      expect(effectCovered('lee', step)).toBe(true);
    }
    expect(effectCovered('escribe-local', 'escribe-local')).toBe(true);
    expect(effectCovered('escribe-local', 'lee')).toBe(false);
    expect(effectCovered('escribe-local', 'envia-terceros')).toBe(false);
    expect(effectCovered('escribe-local', 'paga')).toBe(false);
    expect(effectCovered('escribe-local', 'destructivo')).toBe(false);
    expect(effectCovered('envia-terceros', 'envia-terceros')).toBe(true);
    expect(effectCovered('envia-terceros', 'paga')).toBe(true);
    expect(effectCovered('envia-terceros', 'escribe-local')).toBe(false);
    expect(effectCovered('envia-terceros', 'destructivo')).toBe(false);
    expect(effectCovered('paga', 'paga')).toBe(true);
    expect(effectCovered('paga', 'envia-terceros')).toBe(false);
    expect(effectCovered('paga', 'destructivo')).toBe(false);
    expect(effectCovered('destructivo', 'destructivo')).toBe(true);
    expect(effectCovered('destructivo', 'paga')).toBe(false);
    expect(EFFECT_LABEL['envia-terceros']).toBe('envía a terceros');
  });

  it('effectOverrideReason: null without gestion, when covered, or for reads without valid step', () => {
    expect(effectOverrideReason(null, 'paga')).toBeNull();
    expect(effectOverrideReason(null, null)).toBeNull();
    const gestor = new GestorStore({ db: newDb() });
    const g = proposeIn(gestor);
    expect(effectOverrideReason(g, 'envia-terceros')).toBeNull(); // proposed, not active
    gestor.start(g.id);
    expect(effectOverrideReason(gestor.read(g.id) ?? null, 'lee')).toBeNull();
  });

  it('effectOverrideReason: exceeding, unprovable and finished-not-closed all ask', () => {
    const gestor = new GestorStore({ db: newDb() });
    const g = proposeIn(gestor);
    gestor.start(g.id);
    // Exceeds the approved class of step 1 (lee).
    const reason = effectOverrideReason(gestor.read(g.id) ?? null, 'envia-terceros');
    expect(reason).toContain('paso 1');
    expect(reason).toContain('[solo lectura]');
    expect(reason).toContain('[envía a terceros]');
    // Unprovable class: asks whatever the step declares.
    const opaque = effectOverrideReason(gestor.read(g.id) ?? null, null);
    expect(opaque).toContain('no puedo probar la clase de efecto');
    expect(opaque).toContain('paso 1');
    gestor.recordStep(g.id, 0, 'ok');
    // Step 2 is envia-terceros: a send is covered now; writes and payments are not.
    expect(effectOverrideReason(gestor.read(g.id) ?? null, 'envia-terceros')).toBeNull();
    expect(effectOverrideReason(gestor.read(g.id) ?? null, 'escribe-local')).toContain(
      '[escribe en tu PC]',
    );
    expect(effectOverrideReason(gestor.read(g.id) ?? null, 'paga')).toContain('[paga]');
    gestor.recordStep(g.id, 1, 'ok');
    // All steps marked but the gestion is still ACTIVE: fail closed for effects.
    expect(effectOverrideReason(gestor.read(g.id) ?? null, 'lee')).toBeNull();
    const tail = effectOverrideReason(gestor.read(g.id) ?? null, 'envia-terceros');
    expect(tail).toContain('plan completado sin cerrar');
    expect(effectOverrideReason(gestor.read(g.id) ?? null, null)).toContain(
      'plan completado sin cerrar',
    );
    gestor.complete(g.id);
    expect(effectOverrideReason(gestor.read(g.id) ?? null, 'paga')).toBeNull();
  });

  it('effectOverrideReason: a corrupt plan fails closed for effects', () => {
    const gestor = new GestorStore({ db: newDb() });
    const g = gestor.propose({
      scope: SCOPE,
      title: 'corrupta',
      encargo: 'x',
      plan: plan('lee'),
    });
    gestor.start(g.id);
    const raw = gestor.read(g.id);
    expect(raw).not.toBeNull();
    // Simulate a row whose currentStep points past the plan (corrupt).
    const corrupt = { ...raw!, currentStep: 99 };
    expect(effectOverrideReason(corrupt, 'lee')).toBeNull();
    expect(effectOverrideReason(corrupt, 'envia-terceros')).toContain('sin cerrar');
    expect(effectOverrideReason(corrupt, null)).toContain('sin cerrar');
  });
});

describe('gestion tool', () => {
  function setup(scope = SCOPE) {
    const gestor = new GestorStore({ db: newDb() });
    const tool = createGestionTool({ gestor, scopeOf: () => scope });
    const run = (args: Record<string, unknown>) => tool.execute('c', args as never);
    const text = (r: { content: { type: string; text?: string }[] }) =>
      r.content.map((c) => c.text ?? '').join('\n');
    return { gestor, run, text };
  }

  const goodPlan = [
    { texto: 'Abrir el portal y localizar el formulario', efecto: 'lee' },
    { texto: 'Enviar el formulario', efecto: 'envia-terceros' },
  ];

  it('preparar needs titulo, encargo and at least one step', async () => {
    const { run, text } = setup();
    expect(text(await run({ action: 'preparar' }))).toContain('necesita titulo y encargo');
    expect(text(await run({ action: 'preparar', titulo: 'x', encargo: 'y' }))).toContain(
      'al menos un paso',
    );
  });

  it('preparar rejects an unknown effect class, naming the step', async () => {
    const { run, text } = setup();
    const r = await run({
      action: 'preparar',
      titulo: 'x',
      encargo: 'y',
      pasos: [{ texto: 'haz cosa', efecto: 'magia' }],
    });
    expect(text(r)).toContain('paso 1');
    expect(text(r)).toContain('clase de efecto desconocida');
    expect(text(r)).toContain(EFFECT_CLASSES.join(', '));
  });

  it('preparar stores the proposal and shows every step with its effect class', async () => {
    const { gestor, run, text } = setup();
    const r = await run({
      action: 'preparar',
      titulo: 'alta portal',
      encargo: 'hazme el alta, NO ENVIES sin decirmelo',
      pasos: goodPlan,
    });
    const t = text(r);
    expect(t).toContain('Gestión propuesta: "alta portal"');
    expect(t).toContain('NO ENVIES sin decirmelo');
    expect(t).toContain('1. [solo lectura] Abrir el portal');
    expect(t).toContain('2. [envía a terceros] Enviar el formulario');
    expect(t).toContain('te pregunto sí o sí');
    expect(t).toContain('vault');
    expect(t.length).toBeLessThanOrEqual(MAX_GESTION_CHARS);
    const rows = gestor.list(SCOPE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('proposed');
  });

  it('preparar enforces the one-message budget and stores nothing over it', async () => {
    const { gestor, run, text } = setup();
    const big = Array.from({ length: 20 }, (_, i) => ({
      texto: `paso ${i + 1} `.padEnd(190, 'con detalle '),
      efecto: 'lee',
    }));
    const r = await run({
      action: 'preparar',
      titulo: 'demasiado larga',
      encargo: 'x'.repeat(900),
      pasos: big,
    });
    expect(text(r)).toContain('no cabe en un solo mensaje');
    expect(text(r)).toContain('Nada quedó guardado');
    expect(gestor.list(SCOPE)).toHaveLength(0);
  });

  it('preparar enforces length limits on title, encargo and steps', async () => {
    const { run, text } = setup();
    expect(
      text(
        await run({ action: 'preparar', titulo: 't'.repeat(121), encargo: 'e', pasos: goodPlan }),
      ),
    ).toContain('título no puede pasar de 120');
    expect(
      text(
        await run({
          action: 'preparar',
          titulo: 'ok',
          encargo: 'e'.repeat(1001),
          pasos: goodPlan,
        }),
      ),
    ).toContain('encargo no puede pasar de 1000');
    expect(
      text(
        await run({
          action: 'preparar',
          titulo: 'ok',
          encargo: 'ok',
          pasos: [{ texto: 'p'.repeat(201), efecto: 'lee' }],
        }),
      ),
    ).toContain('paso 1 no puede pasar de 200');
  });

  it('ejecutar activates and returns step 1; a second ejecutar fails', async () => {
    const { gestor, run, text } = setup();
    await run({ action: 'preparar', titulo: 'alta', encargo: 'e', pasos: goodPlan });
    const id = gestor.list(SCOPE)[0]?.id ?? '';
    const r = await run({ action: 'ejecutar', id });
    expect(text(r)).toContain('activa');
    expect(text(r)).toContain('paso 1');
    expect(gestor.read(id)?.status).toBe('active');
    const again = await run({ action: 'ejecutar', id });
    expect(text(again)).toContain('Solo se ejecuta una gestión propuesta');
  });

  it('ejecutar refuses another gestion while one is active', async () => {
    const { gestor, run, text } = setup();
    await run({ action: 'preparar', titulo: 'a', encargo: 'e', pasos: goodPlan });
    await run({ action: 'preparar', titulo: 'b', encargo: 'e', pasos: goodPlan });
    const [first, second] = gestor.list(SCOPE);
    await run({ action: 'ejecutar', id: first?.id ?? '' });
    const r = await run({ action: 'ejecutar', id: second?.id ?? '' });
    expect(text(r)).toContain('Ya hay una gestión activa');
  });

  it('a gestion cannot be touched from another chat', async () => {
    const { gestor, run, text } = setup();
    await run({ action: 'preparar', titulo: 'a', encargo: 'e', pasos: goodPlan });
    const id = gestor.list(SCOPE)[0]?.id ?? '';
    // Same store, another chat's scope: the row exists but is not yours.
    const other = createGestionTool({ gestor, scopeOf: () => OTHER });
    const r = await other.execute('c', { action: 'ejecutar', id } as never);
    expect(text(r)).toContain('pertenece a otro chat');
    expect(gestor.read(id)?.status).toBe('proposed');
  });

  it('paso defaults to the active gestion, advances and completar closes', async () => {
    const { gestor, run, text } = setup();
    await run({ action: 'preparar', titulo: 'a', encargo: 'e', pasos: goodPlan });
    const id = gestor.list(SCOPE)[0]?.id ?? '';
    await run({ action: 'ejecutar', id });
    const p1 = await run({ action: 'paso', paso: 1, nota: 'portal localizado' });
    expect(text(p1)).toContain('marcado como hecho');
    expect(text(p1)).toContain('Sigue el paso 2');
    const notYet = await run({ action: 'completar' });
    expect(text(notYet)).toContain('Aún quedan pasos sin hacer (2)');
    await run({ action: 'paso', paso: 2, nota: 'enviado' });
    const done = await run({ action: 'completar' });
    expect(text(done)).toContain('terminada');
    expect(text(done)).toContain('2 pasos registrados');
    expect(gestor.read(id)?.status).toBe('done');
    expect(gestor.read(id)?.ledger).toHaveLength(2);
  });

  it('paso without an active gestion, with a bad number or repeated errors cleanly', async () => {
    const { gestor, run, text } = setup();
    expect(text(await run({ action: 'paso', paso: 1 }))).toContain('ninguna gestión activa');
    await run({ action: 'preparar', titulo: 'a', encargo: 'e', pasos: goodPlan });
    const id = gestor.list(SCOPE)[0]?.id ?? '';
    await run({ action: 'ejecutar', id });
    expect(text(await run({ action: 'paso', paso: 1.5 }))).toContain('número entero');
    expect(text(await run({ action: 'paso', paso: 99 }))).toContain('número entero');
    await run({ action: 'paso', paso: 1 });
    expect(text(await run({ action: 'paso', paso: 1 }))).toContain('ya estaba marcado');
    expect(gestor.read(id)?.ledger).toHaveLength(1);
  });

  it('listar hides finished gestiones and estado renders plan and ledger', async () => {
    const { gestor, run, text } = setup();
    expect(text(await run({ action: 'listar' }))).toContain('No hay gestiones');
    await run({ action: 'preparar', titulo: 'alta', encargo: 'e', pasos: goodPlan });
    const id = gestor.list(SCOPE)[0]?.id ?? '';
    expect(text(await run({ action: 'listar' }))).toContain('"alta"');
    await run({ action: 'ejecutar', id });
    await run({ action: 'paso', paso: 1, nota: 'portal localizado' });
    const st = text(await run({ action: 'estado' }));
    expect(st).toContain('[x] [solo lectura] Abrir el portal');
    expect(st).toContain('[ ] [envía a terceros] Enviar el formulario');
    expect(st).toContain('paso 1: portal localizado');
    await run({ action: 'paso', paso: 2, nota: 'enviado' });
    await run({ action: 'completar' });
    expect(text(await run({ action: 'listar' }))).toContain('No hay gestiones');
  });

  it('cancelar cancels and rejects a finished one', async () => {
    const { gestor, run, text } = setup();
    await run({ action: 'preparar', titulo: 'a', encargo: 'e', pasos: goodPlan });
    const id = gestor.list(SCOPE)[0]?.id ?? '';
    const r = await run({ action: 'cancelar', id });
    expect(text(r)).toContain('cancelada');
    expect(gestor.read(id)?.status).toBe('cancelled');
  });

  it('formatProposal keeps the request verbatim and names the classes', () => {
    const gestor = new GestorStore({ db: newDb() });
    const g = proposeIn(gestor);
    const t = formatProposal(g);
    expect(t).toContain(g.encargo);
    expect(t).toContain('[solo lectura]');
    expect(t).toContain('[envía a terceros]');
    expect(t.split('\n').some((l) => l.includes('sí o sí'))).toBe(true);
  });
});

describe('Gate: gestion ejecutar always asks', () => {
  const ejecutarCall = {
    tool: 'gestion',
    args: { action: 'ejecutar', id: 'x' },
    actor: 'test',
  };

  it('asks even with an always scope on gestion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-gestor-gate-'));
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    gate.setScope('s', 'gestion', 'always');
    const d = await gate.check('s', ejecutarCall);
    expect(asked).toBe(1);
    expect(d.verdict).toBe('allow');
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks again for a second identical ejecutar (no memo)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-gestor-gate-'));
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    await gate.check('s', ejecutarCall);
    await gate.check('s', ejecutarCall);
    expect(asked).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks under fullControl too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-gestor-gate-'));
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      fullControl: true,
      approver: () => {
        asked++;
        return true;
      },
    });
    const d = await gate.check('s', ejecutarCall);
    expect(asked).toBe(1);
    expect(d.verdict).toBe('allow');
    rmSync(dir, { recursive: true, force: true });
  });

  it('is never waved through as purchase preflight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-gestor-gate-'));
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      allowUntilPayment: true,
      stageOf: () => 'browse',
      approver: () => {
        asked++;
        return true;
      },
    });
    const d = await gate.check('s', ejecutarCall);
    expect(asked).toBe(1);
    expect(d.verdict).toBe('allow');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Gate: classifyEffect provability table', () => {
  const gate = new Gate({ allowUntilPayment: true, approver: () => true });
  const at = (tool: string, args: Record<string, unknown>, stage?: 'browse' | 'fill' | 'confirm') =>
    gate.classifyEffect({ tool, args, actor: 'test', ...(stage ? { stage } : {}) });

  it('money evidence is paga', () => {
    expect(at('browser', { action: 'click', _target: 'button | Pay now @@ Shop' })).toBe('paga');
    expect(at('shell', { command: 'echo 4111111111111111' })).toBe('paga');
    expect(at('checkout', { action: 'fill' }, 'confirm')).toBe('paga');
  });

  it('reads and internal bookkeeping are lee', () => {
    expect(at('read', { path: 'C:\\tmp\\x.txt' })).toBe('lee');
    expect(at('list', { path: 'C:\\tmp' })).toBe('lee');
    expect(at('memory', { action: 'save' })).toBe('lee');
    expect(at('objetivo', { action: 'listar' })).toBe('lee');
    expect(at('gestion', { action: 'ejecutar', id: 'x' })).toBe('lee');
    expect(at('windows', {})).toBe('lee');
    expect(at('computer', { action: 'screenshot' })).toBe('lee');
    expect(at('computer', { action: 'move', x: 1, y: 2 })).toBe('lee');
    expect(at('browser', { action: 'open', url: 'https://example.com' })).toBe('lee');
    expect(at('browser', { action: 'snapshot' })).toBe('lee');
    expect(at('tv', { action: 'state' })).toBe('lee');
    expect(at('tv', { action: 'screenshot' })).toBe('lee');
    expect(at('fetch', { url: 'https://example.com' })).toBe('lee');
    expect(at('fetch', { url: 'https://example.com', method: 'GET' })).toBe('lee');
  });

  it('provable writes and sends get their class', () => {
    expect(at('write', { path: 'C:\\tmp\\x.txt' })).toBe('escribe-local');
    expect(at('edit', { path: 'C:\\tmp\\x.txt' })).toBe('escribe-local');
    expect(at('media', { action: 'tts' })).toBe('escribe-local');
    expect(at('reminder', { action: 'crear' })).toBe('escribe-local');
    expect(at('browser', { action: 'fill', selector: '#email', text: 'a@b.c' })).toBe(
      'escribe-local',
    );
    expect(
      at('browser', { action: 'click', _target: 'link | Leer mas @@ Blog personal' }),
    ).toBe('escribe-local');
    expect(
      at('browser', { action: 'click', _target: 'button | Seguir [destino ilegible]' }),
    ).toBe('envia-terceros');
    expect(at('fetch', { url: 'https://example.com', method: 'POST' })).toBe('envia-terceros');
    expect(at('shell', { command: 'Remove-Item -Recurse C:\\x' })).toBe('destructivo');
    expect(at('checkout', { action: 'fill' }, 'browse')).toBe('escribe-local');
  });

  it('opaque calls are null (unprovable), never a default', () => {
    expect(at('browser', { action: 'exec_js', code: 'document.forms[0].submit()' })).toBeNull();
    expect(at('shell', { command: 'curl -X POST https://api.example.com -d x=1' })).toBeNull();
    expect(at('shell', { command: 'dir' })).toBeNull();
    expect(at('computer', { action: 'click', x: 1, y: 2 })).toBeNull();
    expect(at('computer', { action: 'type', text: 'hola' })).toBeNull();
    expect(at('tv', { action: 'power', value: false })).toBeNull();
    expect(at('book', { action: 'reservar' })).toBeNull();
    expect(at('opengym', { action: 'reservar' })).toBeNull();
    expect(at('herramienta_de_fabrica', { anything: true })).toBeNull();
  });
});

describe('Gate: gestor effect guard (forced ask)', () => {
  const shellCall = { tool: 'shell', args: { command: 'dir' }, actor: 'test' };

  function wiredGate(
    dir: string,
    gestor: GestorStore,
    approver: (reason: string) => boolean,
    extra: Record<string, unknown> = {},
  ) {
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      grantWindowMs: 0,
      ...extra,
      approver: (_call: unknown, reason: string) => approver(reason),
    });
    gate.setForcedAsk(SCOPE, (call) =>
      effectOverrideReason(gestor.activeForScope(SCOPE), gate.classifyEffect(call)),
    );
    return gate;
  }

  it('an opaque call in a lee step asks every time, memo or no memo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-gestor-gate-'));
    const gestor = new GestorStore({ db: newDb() });
    const g = proposeIn(gestor);
    gestor.start(g.id); // step 1 is 'lee'
    const reasons: string[] = [];
    const gate = wiredGate(dir, gestor, (reason) => {
      reasons.push(reason);
      return true;
    });
    await gate.check(SCOPE, shellCall);
    await gate.check(SCOPE, shellCall);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain('no puedo probar la clase de efecto');
    expect(reasons[0]).toContain('paso 1');
    expect(reasons[0]).toContain('[solo lectura]');
    rmSync(dir, { recursive: true, force: true });
  });

  it('auditor repro: exec_js, fill, curl POST, computer click and tv power all ask', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-gestor-gate-'));
    const gestor = new GestorStore({ db: newDb() });
    const g = gestor.propose({
      scope: SCOPE,
      title: 'x',
      encargo: 'x',
      plan: plan('lee', 'escribe-local'),
    });
    gestor.start(g.id); // step 1: lee
    const reasons: string[] = [];
    const gate = wiredGate(dir, gestor, (reason) => {
      reasons.push(reason);
      return true;
    });
    const execJs = {
      tool: 'browser',
      args: { action: 'exec_js', code: 'document.querySelector("button").click()' },
      actor: 'test',
    };
    const fill = {
      tool: 'browser',
      args: { action: 'fill', selector: '#email', text: 'a@b.c' },
      actor: 'test',
    };
    const tv = { tool: 'tv', args: { action: 'power', value: false }, actor: 'test' };
    await gate.check(SCOPE, execJs);
    await gate.check(SCOPE, execJs); // no memo for opaque calls
    await gate.check(SCOPE, fill);
    await gate.check(SCOPE, tv);
    expect(reasons).toHaveLength(4);
    gestor.recordStep(g.id, 0, 'ok'); // step 2: escribe-local
    const curl = {
      tool: 'shell',
      args: { command: 'curl -X POST https://api.example.com -d x=1' },
      actor: 'test',
    };
    const click = { tool: 'computer', args: { action: 'click', x: 10, y: 20 }, actor: 'test' };
    await gate.check(SCOPE, curl);
    await gate.check(SCOPE, click);
    expect(reasons).toHaveLength(6);
    rmSync(dir, { recursive: true, force: true });
  });

  it('opaque calls still ask under fullControl, always-scope and a live grant window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-gestor-gate-'));
    const gestor = new GestorStore({ db: newDb() });
    const g = proposeIn(gestor);
    gestor.start(g.id);
    let asked = 0;
    const gate = wiredGate(
      dir,
      gestor,
      () => {
        asked++;
        return true;
      },
      { fullControl: true, grantWindowMs: 60_000 },
    );
    gate.setScope(SCOPE, 'computer', 'always');
    const click = { tool: 'computer', args: { action: 'click', x: 10, y: 20 }, actor: 'test' };
    await gate.check(SCOPE, click); // forced ask (approval opens the computer window)
    await gate.check(SCOPE, click); // window + scope + fullControl: still asks
    expect(asked).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('advancing the step relaxes the guard to the new class', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-gestor-gate-'));
    const gestor = new GestorStore({ db: newDb() });
    const g = proposeIn(gestor); // lee, envia-terceros
    gestor.start(g.id);
    let asked = 0;
    const gate = wiredGate(dir, gestor, () => {
      asked++;
      return true;
    });
    const effectClick = {
      tool: 'browser',
      args: { action: 'click', _target: 'button | Seguir [destino ilegible]' },
      actor: 'test',
    };
    await gate.check(SCOPE, effectClick); // forced: envia over lee
    expect(asked).toBe(1);
    gestor.recordStep(g.id, 0, 'ok'); // now step 2: envia-terceros
    // Covered now, and this exact call was explicitly approved a moment ago
    // (the forced ask recorded its fingerprint), so the memo applies.
    await gate.check(SCOPE, effectClick);
    await gate.check(SCOPE, effectClick);
    expect(asked).toBe(1);
    // ...but a payment call in a sending step still forces the ask.
    const payCall = {
      tool: 'browser',
      args: { action: 'click', _target: 'button | Pay now @@ Shop' },
      actor: 'test',
    };
    await gate.check(SCOPE, payCall);
    expect(asked).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('last step marked but not closed: effects keep asking until completar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-gestor-gate-'));
    const gestor = new GestorStore({ db: newDb() });
    const g = gestor.propose({
      scope: SCOPE,
      title: 'x',
      encargo: 'x',
      plan: plan('lee'),
    });
    gestor.start(g.id);
    gestor.recordStep(g.id, 0, 'ok'); // plan marked done, gestion STILL active
    const reasons: string[] = [];
    const gate = wiredGate(dir, gestor, (reason) => {
      reasons.push(reason);
      return true;
    });
    const payCall = {
      tool: 'browser',
      args: { action: 'click', _target: 'button | Pay now @@ Shop' },
      actor: 'test',
    };
    await gate.check(SCOPE, payCall);
    expect(reasons[0]).toContain('plan completado sin cerrar');
    // Reads stay free of the FORCED ask so the model can close the gestion
    // (a gate that allow-lists reads never hears about them).
    let readAsked = 0;
    const gate2 = wiredGate(
      dir,
      gestor,
      () => {
        readAsked++;
        return true;
      },
      { allow: ['read'] },
    );
    await gate2.check(SCOPE, { tool: 'read', args: { path: 'x' }, actor: 'test' });
    expect(readAsked).toBe(0);
    gestor.complete(g.id);
    await gate.check(SCOPE, payCall); // closed: normal path (payment rule asks)
    expect(reasons[1] ?? '').not.toContain('plan completado sin cerrar');
    rmSync(dir, { recursive: true, force: true });
  });

  it('a finished gestion stops forcing on its own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-gestor-gate-'));
    const gestor = new GestorStore({ db: newDb() });
    const g = proposeIn(gestor);
    gestor.start(g.id);
    gestor.recordStep(g.id, 0, 'ok');
    gestor.recordStep(g.id, 1, 'ok');
    gestor.complete(g.id);
    let asked = 0;
    const gate = wiredGate(dir, gestor, () => {
      asked++;
      return true;
    });
    await gate.check(SCOPE, shellCall); // normal path: asks once (unlisted)
    await gate.check(SCOPE, shellCall); // memo
    expect(asked).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('deny still wins over a forced ask', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-gestor-gate-'));
    const gestor = new GestorStore({ db: newDb() });
    const g = proposeIn(gestor);
    gestor.start(g.id);
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      deny: ['shell'],
      approver: () => {
        asked++;
        return true;
      },
    });
    gate.setForcedAsk(SCOPE, (call) =>
      effectOverrideReason(gestor.activeForScope(SCOPE), gate.classifyEffect(call)),
    );
    const d = await gate.check(SCOPE, shellCall);
    expect(d.verdict).toBe('deny');
    expect(asked).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fullControl does not wave a forced ask', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-gestor-gate-'));
    const gestor = new GestorStore({ db: newDb() });
    const g = proposeIn(gestor);
    gestor.start(g.id);
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      fullControl: true,
      approver: () => {
        asked++;
        return true;
      },
    });
    gate.setForcedAsk(SCOPE, (call) =>
      effectOverrideReason(gestor.activeForScope(SCOPE), gate.classifyEffect(call)),
    );
    await gate.check(SCOPE, shellCall);
    expect(asked).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('setForcedAsk(null) removes the guard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-gestor-gate-'));
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'g.db'),
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    gate.setForcedAsk(SCOPE, () => 'forzado');
    await gate.check(SCOPE, shellCall);
    gate.setForcedAsk(SCOPE, null);
    await gate.check(SCOPE, shellCall); // memo from the first approval
    expect(asked).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('no gestion active means the predicate stays silent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-gestor-gate-'));
    const gestor = new GestorStore({ db: newDb() });
    let asked = 0;
    const gate = wiredGate(dir, gestor, () => {
      asked++;
      return true;
    });
    await gate.check(SCOPE, shellCall); // unlisted: asks once
    await gate.check(SCOPE, shellCall); // memo
    expect(asked).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
