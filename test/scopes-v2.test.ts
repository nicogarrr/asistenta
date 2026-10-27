import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { amountWithinCap, Gate, scopeKey } from '../src/permissions.js';

/**
 * Scopes v2: un permiso puede ser por herramienta o por ACCIÓN exacta.
 *
 * La propiedad que importa es la asimetría: una acción concreta y sus argumentos
 * pueden recordarse, pero las acciones que mueven el ratón, escriben en el
 * terminal, abren la cámara o tocan una ruta protegida NUNCA se convierten en un
 * permiso reutilizable. Un "siempre" viejo en disco tampoco puede resucitar
 * sobre ellas.
 */
describe('scopes v2: claves por acción', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scopeKey usa tool:action:hash estable de los argumentos', () => {
    const a = scopeKey('browser', 'click', { action: 'click', selector: 'text=Ver menú' });
    const b = scopeKey('browser', 'click', { selector: 'text=Ver menú', action: 'click' });
    const c = scopeKey('browser', 'click', { action: 'click', selector: 'text=Siguiente' });
    expect(a).toMatch(/^browser:click:[a-f0-9]{32}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain('Ver menú');
  });

  it('un scope de acción cubre solo esa acción con esos argumentos', async () => {
    let asked = 0;
    const gate = new Gate({
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return false;
      },
    });
    const args = { action: 'click', selector: 'text=Ver menú' };
    const key = scopeKey('browser', 'click', args);
    gate.setScope('s', key, 'always');
    expect(gate.scopeFor('s', key)).toBe('always');

    const covered = await gate.check('s', { tool: 'browser', args, actor: 'local' });
    expect(covered.verdict).toBe('allow');
    expect(covered.reason).toBe('always-allow scope');
    expect(asked).toBe(0);

    const other = await gate.check('s', {
      tool: 'browser',
      args: { action: 'click', selector: 'text=Siguiente' },
      actor: 'local',
    });
    expect(other.verdict).toBe('deny');
    expect(asked).toBe(1);
  });

  it('recarga la clave exacta, sin ampliar a toda la herramienta si la BD falla', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-action-cache-'));
    const dbPath = join(dir, 'scopes.db');
    try {
      const args = { action: 'click', selector: 'text=Ver menú' };
      const key = scopeKey('browser', 'click', args);
      const before = new Gate({ dbPath, grantWindowMs: 0 });
      before.setScope('before', key, 'always');
      const ask = vi.fn(() => false);
      const after = new Gate({ dbPath, grantWindowMs: 0, approver: ask });

      // Fail the first read after restart, before scopeFor can repair the cache.
      rmSync(dbPath);
      mkdirSync(dbPath);
      expect(after.scopeFor('after', 'browser')).toBe('unset');
      expect(after.scopeFor('after', key)).toBe('always');
      expect((await after.check('after', { tool: 'browser', args, actor: 'local' })).reason).toBe(
        'always-allow scope',
      );
      const other = await after.check('after', {
        tool: 'browser',
        args: { action: 'click', selector: 'text=Siguiente' },
        actor: 'local',
      });
      expect(other.verdict).toBe('deny');
      expect(ask).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('un scope por herramienta sigue funcionando para acciones seguras', async () => {
    let asked = 0;
    const gate = new Gate({
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    gate.setScope('s', 'fetch', 'always');
    const d = await gate.check('s', {
      tool: 'fetch',
      args: { url: 'https://example.com' },
      actor: 'local',
    });
    expect(d.verdict).toBe('allow');
    expect(d.reason).toBe('always-allow scope');
    expect(asked).toBe(0);
  });

  it('shell no admite always ni session: cada comando vuelve a preguntar', async () => {
    let asked = 0;
    const gate = new Gate({
      grantWindowMs: 60_000,
      approver: () => {
        asked++;
        return true;
      },
    });
    for (const scope of ['always', 'session'] as const) {
      gate.setScope('s', 'shell', scope);
      expect(gate.scopeFor('s', 'shell'), scope).toBe('unset');
      const d = await gate.check('s', {
        tool: 'shell',
        args: { command: `echo ${scope}` },
        actor: 'local',
      });
      expect(d.verdict, scope).toBe('allow');
      expect(d.reason, scope).toBe('approved by local');
    }
    expect(asked).toBe(2);

    // La aprobación exacta sí cabe: `once` no es un permiso reutilizable.
    gate.setScope('s', 'shell', 'once');
    expect(gate.scopeFor('s', 'shell')).toBe('once');
  });

  it('computer con click/type/key/drag no se cubre ni por acción ni por herramienta', async () => {
    let asked = 0;
    const gate = new Gate({
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    const clickArgs = { action: 'click', x: 1, y: 1 };
    const actionKey = scopeKey('computer', 'click', clickArgs);
    gate.setScope('s', actionKey, 'always');
    expect(gate.scopeFor('s', actionKey)).toBe('unset');
    gate.setScope('s', 'computer', 'always');
    expect(gate.scopeFor('s', 'computer')).toBe('always');

    const d = await gate.check('s', { tool: 'computer', args: clickArgs, actor: 'local' });
    expect(d.verdict).toBe('allow');
    expect(d.reason).toBe('approved by local');
    expect(asked).toBe(1);
  });

  it('browser exec_js no admite always/session', async () => {
    let asked = 0;
    const gate = new Gate({
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    const args = { action: 'exec_js', code: 'document.body.remove()' };
    const key = scopeKey('browser', 'exec_js', args);
    gate.setScope('s', key, 'always');
    expect(gate.scopeFor('s', key)).toBe('unset');
    const d = await gate.check('s', { tool: 'browser', args, actor: 'local' });
    expect(d.reason).toBe('approved by local');
    expect(asked).toBe(1);
  });

  it('media: cámara/micrófono no se cubren, pero play sí', async () => {
    let asked = 0;
    const gate = new Gate({
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    gate.setScope('s', 'media', 'always');
    expect(gate.scopeFor('s', 'media')).toBe('always');

    const camera = await gate.check('s', {
      tool: 'media',
      args: { action: 'camera_photo' },
      actor: 'local',
    });
    expect(camera.reason).toBe('approved by local');
    expect(asked).toBe(1);

    const play = await gate.check('s', {
      tool: 'media',
      args: { action: 'play' },
      actor: 'local',
    });
    expect(play.reason).toBe('always-allow scope');
    expect(asked).toBe(1);
  });

  it('write a ruta protegida no se cubre con always; una ruta normal sí', async () => {
    let asked = 0;
    const gate = new Gate({
      allow: ['write'],
      protectedPaths: ['C:\\Users\\nicoi\\.ssh'],
      approver: () => {
        asked++;
        return true;
      },
    });
    gate.setScope('s', 'write', 'always');

    const blocked = await gate.check('s', {
      tool: 'write',
      args: { path: 'C:\\Users\\nicoi\\.ssh\\authorized_keys', content: 'x' },
      actor: 'local',
    });
    expect(blocked.verdict).toBe('deny');
    expect(asked).toBe(0);

    const safe = await gate.check('s', {
      tool: 'write',
      args: { path: 'C:\\Users\\nicoi\\Documents\\nota.txt', content: 'x' },
      actor: 'local',
    });
    expect(safe.verdict).toBe('allow');
    expect(safe.reason).toBe('always-allow scope');
    expect(asked).toBe(0);
  });

  it('session de una acción dura la ventana de concesión (grantWindowMs)', async () => {
    const start = 2_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    let asked = 0;
    const gate = new Gate({
      grantWindowMs: 25,
      approver: () => {
        asked++;
        return true;
      },
    });
    const args = { action: 'click', selector: 'text=Ver menú' };
    const key = scopeKey('browser', 'click', args);
    gate.setScope('s', key, 'session');
    expect(gate.scopeFor('s', key)).toBe('session');

    const covered = await gate.check('s', { tool: 'browser', args, actor: 'local' });
    expect(covered.verdict).toBe('allow');
    expect(asked).toBe(0);

    clock.mockReturnValue(start + 24);
    expect(gate.scopeFor('s', key)).toBe('session');
    clock.mockReturnValue(start + 25);
    expect(gate.scopeFor('s', key)).toBe('unset');
    const expired = await gate.check('s', { tool: 'browser', args, actor: 'local' });
    expect(expired.reason).toBe('approved by local');
    expect(asked).toBe(1);
  });

  it('un always de acción persiste, se revoca con su herramienta y no resucita', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-scopes-v2-'));
    try {
      const dbPath = join(dir, 'scopes.db');
      let asked = 0;
      const approver = () => {
        asked++;
        return true;
      };
      const args = { action: 'click', selector: 'text=Ver menú' };
      const key = scopeKey('browser', 'click', args);
      const gate = new Gate({ dbPath, grantWindowMs: 0, approver });
      gate.setScope('s', key, 'always');
      const first = await gate.check('s', { tool: 'browser', args, actor: 'local' });
      expect(first.reason).toBe('always-allow scope');

      const reborn = new Gate({ dbPath, grantWindowMs: 0, approver });
      expect(reborn.scopeFor('s', key)).toBe('always');
      expect(reborn.listPersistedAlways()).toEqual(['browser']);
      const second = await reborn.check('s', { tool: 'browser', args, actor: 'local' });
      expect(second.reason).toBe('always-allow scope');
      expect(asked).toBe(0);

      expect(reborn.revokeAlways('browser')).toBe(true);
      expect(reborn.scopeFor('s', key)).toBe('unset');
      const third = await reborn.check('s', { tool: 'browser', args, actor: 'local' });
      expect(third.reason).toBe('approved by local');
      expect(asked).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('un lote de computer con clics no admite always/session', async () => {
    let asked = 0;
    const gate = new Gate({
      grantWindowMs: 0,
      approver: () => {
        asked++;
        return true;
      },
    });
    const args = {
      action: 'batch',
      actions: [{ action: 'click', x: 1, y: 1 }],
    };
    const key = scopeKey('computer', 'batch', args);
    gate.setScope('s', key, 'always');
    expect(gate.scopeFor('s', key)).toBe('unset');
    const d = await gate.check('s', { tool: 'computer', args, actor: 'local' });
    expect(d.reason).toBe('approved by local');
    expect(asked).toBe(1);
  });
});

describe('amountWithinCap', () => {
  it('acepta el límite exacto y rechaza lo que no es un importe válido', () => {
    expect(amountWithinCap(0, 0)).toBe(true);
    expect(amountWithinCap(29_999, 30_000)).toBe(true);
    expect(amountWithinCap(30_000, 30_000)).toBe(true);
    expect(amountWithinCap(30_001, 30_000)).toBe(false);
    expect(amountWithinCap(-1, 30_000)).toBe(false);
    expect(amountWithinCap(Number.NaN, 30_000)).toBe(false);
    expect(amountWithinCap(Number.POSITIVE_INFINITY, 30_000)).toBe(false);
  });

  it('un importe explícito por encima del techo arma la regla de dinero', async () => {
    let asked = 0;
    const gate = new Gate({
      allow: ['read'],
      maxAmountCents: 30_000,
      approver: () => {
        asked++;
        return true;
      },
    });
    const within = await gate.check('s', {
      tool: 'read',
      args: { path: 'a.txt', amountCents: 30_000 },
      actor: 'local',
    });
    expect(within.verdict).toBe('allow');
    expect(asked).toBe(0);

    const over = await gate.check('s', {
      tool: 'read',
      args: { path: 'a.txt', amountCents: 30_001 },
      actor: 'local',
    });
    expect(over.reason).toBe('approved by local');
    expect(asked).toBe(1);
  });
});
