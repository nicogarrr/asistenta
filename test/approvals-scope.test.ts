import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IterationBudget } from '../src/core/budget.js';
import { Gate } from '../src/permissions.js';

/**
 * Approval scopes (`setScope`) and the shared iteration budget.
 *
 * The properties that matter are the escape hatches and their limits: a standing
 * grant must survive a restart but must never cover money or credentials, and a
 * narrowed scope must actually revoke what the wider one granted.
 */
describe('Gate approval scopes', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-scope-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows through an `always` scope without asking, and keeps it across gates', async () => {
    // Without a scope this gate would ask: fetch is not allow-listed here.
    // `fetch` GET es una herramienta segura para un permiso reutilizable; `shell`
    // ya no lo es (ver scopes-v2: un comando aprobado no autoriza otro).
    const dbPath = join(dir, 'scopes.db');
    let asked = 0;
    const approver = () => {
      asked++;
      return true;
    };
    const gate = new Gate({ dbPath, grantWindowMs: 0, approver });
    gate.setScope('s1', 'fetch', 'always');
    expect(gate.scopeFor('s1', 'fetch')).toBe('always');

    const first = await gate.check('s1', {
      tool: 'fetch',
      args: { url: 'https://example.com/a' },
      actor: 'local',
    });
    expect(first.verdict).toBe('allow');
    expect(asked).toBe(0);

    // The point of `always`: a second Gate over the same file must load the grant
    // instead of asking again after a restart.
    const reborn = new Gate({ dbPath, grantWindowMs: 0, approver });
    expect(reborn.scopeFor('s1', 'fetch')).toBe('always');
    const second = await reborn.check('other-session', {
      tool: 'fetch',
      args: { url: 'https://example.com/b' },
      actor: 'local',
    });
    expect(second.verdict).toBe('allow');
    expect(asked).toBe(0);
  });

  it('honours an `always` granted in another thread by a gate built earlier', async () => {
    // One gate lives per conversation. Thread B's gate exists before thread A's
    // "Siempre", so loading the grants only at construction left B asking forever.
    const dbPath = join(dir, 'scopes.db');
    let asked = 0;
    const approver = () => {
      asked++;
      return true;
    };
    const threadA = new Gate({ dbPath, grantWindowMs: 0, approver });
    const threadB = new Gate({ dbPath, grantWindowMs: 0, approver });
    threadA.setScope('a', 'fetch', 'always');

    expect(threadB.scopeFor('b', 'fetch')).toBe('always');
    const call = {
      tool: 'fetch',
      args: { url: 'https://example.com/a' },
      actor: 'local',
    } as const;
    const decision = await threadB.check('b', call);
    expect(decision.verdict).toBe('allow');
    expect(asked).toBe(0);

    // And the revocation reaches the live gate too, not only gates built later.
    expect(threadA.revokeAlways('fetch')).toBe(true);
    expect(threadB.scopeFor('b', 'fetch')).toBe('unset');
    await threadB.check('b', call);
    expect(asked).toBe(1);
  });

  it('never lets an `always` scope cover payments or credentials', async () => {
    // Money and credentials always ask. An `always` grant the model could spend on
    // a card number or `id_rsa` is a standing grant on everything those unlock.
    // `browser` puede llevar `always` para acciones normales, así que es la
    // herramienta que demuestra la exclusión dentro del MISMO tool.
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'scopes.db'),
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    gate.setScope('s1', 'browser', 'always');

    const payment = await gate.check('s1', {
      tool: 'browser',
      args: { action: 'click', selector: 'text=Pagar ahora' },
      actor: 'local',
    });
    const credential = await gate.check('s1', {
      tool: 'browser',
      args: { action: 'fill', selector: '#password', secret_key: 'clave' },
      actor: 'local',
    });
    expect(asked).toBe(2);
    // They fall through to the ask path rather than being denied outright.
    expect(payment.verdict).toBe('allow');
    expect(credential.verdict).toBe('allow');
  });

  it('lets a `session` scope expire with the grant window', async () => {
    const start = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    let asked = 0;
    const gate = new Gate({
      grantWindowMs: 25,
      approver: () => {
        asked++;
        return true;
      },
    });
    gate.setScope('s1', 'computer', 'session');

    // `screenshot` es una acción de `computer` que sí admite scope; un clic o
    // una tecla nunca (ver scopes-v2).
    const covered = await gate.check('s1', {
      tool: 'computer',
      args: { action: 'screenshot' },
      actor: 'local',
    });
    expect(covered.verdict).toBe('allow');
    expect(asked).toBe(0);
    expect(gate.scopeFor('s1', 'computer')).toBe('session');

    // Frontera exacta, sin depender de 25ms reales bajo contención de la suite.
    clock.mockReturnValue(start + 24);
    expect(gate.scopeFor('s1', 'computer')).toBe('session');
    clock.mockReturnValue(start + 25);
    const expired = await gate.check('s1', {
      tool: 'computer',
      args: { action: 'screenshot' },
      actor: 'local',
    });
    expect(asked).toBe(1);
    expect(expired.reason).toBe('approved by local');
    expect(gate.scopeFor('s1', 'computer')).toBe('unset');
  });

  it('covers exactly one call with `once`, even when the grant window is long', async () => {
    // `once` must suppress the trust window: a second, different call is a new
    // question even though grantWindowMs would otherwise cover it.
    let asked = 0;
    const gate = new Gate({
      grantWindowMs: 60_000,
      approver: () => {
        asked++;
        return true;
      },
    });
    gate.setScope('s1', 'computer', 'once');

    const first = {
      tool: 'computer',
      args: { action: 'click', x: 1, y: 1 },
      actor: 'local',
    } as const;
    await gate.check('s1', first);
    gate.settle('s1', first, false); // clean end of the first call
    expect(asked).toBe(1);
    // The identical call is still covered by the approval fingerprint.
    const same = await gate.check('s1', {
      tool: 'computer',
      args: { action: 'click', x: 1, y: 1 },
      actor: 'local',
    });
    expect(same.verdict).toBe('allow');
    expect(asked).toBe(1);

    const different = await gate.check('s1', {
      tool: 'computer',
      args: { action: 'click', x: 2, y: 2 },
      actor: 'local',
    });
    expect(asked).toBe(2);
    expect(different.reason).toBe('approved by local');
  });

  it('revokes the standing grant when the scope is narrowed to `once`', async () => {
    let asked = 0;
    const gate = new Gate({
      dbPath: join(dir, 'scopes.db'),
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    gate.setScope('s1', 'fetch', 'always');
    gate.setScope('s1', 'fetch', 'once');
    expect(gate.scopeFor('s1', 'fetch')).toBe('once');

    await gate.check('s1', {
      tool: 'fetch',
      args: { url: 'https://example.com/a' },
      actor: 'local',
    });
    expect(asked).toBe(1);

    // And the revocation is durable: a fresh Gate must not resurrect the grant.
    const reborn = new Gate({
      dbPath: join(dir, 'scopes.db'),
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    expect(reborn.scopeFor('s1', 'fetch')).toBe('unset');
  });

  it('keeps the deny list a wall that no scope can talk past', async () => {
    const gate = new Gate({ deny: ['shell'], approver: () => true });
    gate.setScope('s1', 'shell', 'always');
    const d = await gate.check('s1', { tool: 'shell', args: { command: 'dir' }, actor: 'local' });
    expect(d.verdict).toBe('deny');
  });

  it('drops session scopes when the session ends but keeps `always`', async () => {
    const gate = new Gate({ grantWindowMs: 60_000, approver: () => true });
    gate.setScope('s1', 'computer', 'session');
    gate.setScope('s1', 'fetch', 'always');
    gate.clearSession('s1');
    expect(gate.scopeFor('s1', 'computer')).toBe('unset');
    // `always` is a standing decision, not part of any one task.
    expect(gate.scopeFor('s1', 'fetch')).toBe('always');
  });
});

describe('IterationBudget', () => {
  it('tracks consumption, remaining and exhaustion', () => {
    const budget = new IterationBudget(5);
    expect(budget.remaining()).toBe(5);
    expect(budget.isExhausted()).toBe(false);

    budget.consume();
    budget.consume(2);
    expect(budget.remaining()).toBe(2);
    expect(budget.isExhausted()).toBe(false);

    // Overdraft floors at zero: an exhausted budget is a state, not an error.
    budget.consume(9);
    expect(budget.remaining()).toBe(0);
    expect(budget.isExhausted()).toBe(true);
  });

  it('warns through the three pressure tramos', () => {
    const budget = new IterationBudget(20);
    budget.consume(10); // 50% left
    expect(budget.pressure()).toBeNull();

    budget.consume(4); // 30% left: no longer "plenty", so the warning starts here
    expect(budget.pressure()).toBe('De esta tarea quedan 6 pasos de 20. Cierra con lo que tengas.');

    budget.consume(3); // 15% left: the documented example
    expect(budget.pressure()).toBe('De esta tarea quedan 3 pasos de 20. Cierra con lo que tengas.');

    budget.consume(1); // 10% left: still the plain warning, urgency starts below
    expect(budget.pressure()).toBe('De esta tarea quedan 2 pasos de 20. Cierra con lo que tengas.');

    budget.consume(1); // 5% left
    expect(budget.pressure()).toBe(
      '¡Atención! De esta tarea queda solo 1 paso de 20. Cierra ya con lo que tengas.',
    );

    budget.consume(1); // nothing left
    expect(budget.pressure()).toBe(
      'Se ha agotado el presupuesto de esta tarea: 20 pasos. Cierra con lo que tengas.',
    );
  });

  it('shares one counter with child budgets', () => {
    // Subagents spend the parent's iterations: delegation must not buy allowance.
    const parent = new IterationBudget(4);
    const child = parent.child();

    child.consume(3);
    expect(parent.remaining()).toBe(1);
    expect(parent.isExhausted()).toBe(false);

    parent.consume();
    expect(child.remaining()).toBe(0);
    expect(child.isExhausted()).toBe(true);
    expect(parent.remaining()).toBe(0);
  });
});
