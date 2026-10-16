import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteAlwaysGrant,
  Gate,
  listAlwaysGrants,
  runPermisosCommand,
} from '../src/permissions.js';

const YES = () => true;

describe('/permisos command', () => {
  let dir = '';
  let dbPath = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-permisos-'));
    dbPath = join(dir, 'approvals.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const gateWith = () => new Gate({ allow: ['read'], approver: YES, dbPath });

  it('a standing grant is shared through the DB: a second gate sees it', () => {
    const a = gateWith();
    a.registerSession('s');
    a.setScope('s', 'exec', 'always');
    const b = gateWith();
    expect(b.listPersistedAlways()).toContain('exec');
    expect(listAlwaysGrants(dbPath)).toEqual(['exec']);
  });

  it('listing with no grants says so and points at the ephemeral ones', () => {
    const msg = runPermisosCommand([gateWith()], dbPath, '');
    expect(msg).toContain('ningún permiso "siempre"');
    expect(msg).toContain('esta sesión');
  });

  it('listing names every standing grant', () => {
    const g = gateWith();
    g.registerSession('s');
    g.setScope('s', 'exec', 'always');
    g.setScope('s', 'browser', 'always');
    const msg = runPermisosCommand([g], dbPath, 'estado');
    expect(msg).toContain('browser');
    expect(msg).toContain('exec');
  });

  it('revocar removes the grant from the DB and every live gate, and the human gets asked again', async () => {
    let asked = 0;
    const countingApprover = () => {
      asked += 1;
      return true;
    };
    const a = new Gate({ allow: ['read'], approver: countingApprover, dbPath });
    a.registerSession('s');
    a.setScope('s', 'exec', 'always');
    await a.check('s', { tool: 'exec', args: { command: 'ls' }, actor: 'local' });
    expect(asked).toBe(0); // the standing grant waved it through
    const other = gateWith(); // a second live gate sharing the DB
    const msg = runPermisosCommand([a, other], dbPath, 'revocar exec');
    expect(msg).toContain('quitado');
    expect(listAlwaysGrants(dbPath)).toEqual([]);
    expect(a.listPersistedAlways()).not.toContain('exec');
    expect(other.listPersistedAlways()).not.toContain('exec');
    expect(a.scopeFor('s', 'exec')).toBe('unset');
    await a.check('s', { tool: 'exec', args: { command: 'ls' }, actor: 'local' });
    expect(asked).toBe(1); // the grant is gone: the human is asked again
  });

  it('revocar works with zero live gates (daemon with no open threads)', () => {
    const g = gateWith();
    g.registerSession('s');
    g.setScope('s', 'exec', 'always');
    const msg = runPermisosCommand([], dbPath, 'revocar exec');
    expect(msg).toContain('quitado');
    expect(listAlwaysGrants(dbPath)).toEqual([]);
  });

  it('revocar todo clears every standing grant', () => {
    const g = gateWith();
    g.registerSession('s');
    g.setScope('s', 'exec', 'always');
    g.setScope('s', 'browser', 'always');
    const msg = runPermisosCommand([g], dbPath, 'revocar todo');
    expect(msg).toContain('los 2 permisos');
    expect(listAlwaysGrants(dbPath)).toEqual([]);
    expect(g.listPersistedAlways()).toEqual([]);
  });

  it('revocar on an unknown tool names the active grants and removes nothing', () => {
    const g = gateWith();
    g.registerSession('s');
    g.setScope('s', 'exec', 'always');
    const msg = runPermisosCommand([g], dbPath, 'revocar shell');
    expect(msg).toContain('No había un permiso "siempre" para shell');
    expect(msg).toContain('exec');
    expect(listAlwaysGrants(dbPath)).toEqual(['exec']);
  });

  it('revocar matches the stored tool name case-insensitively', () => {
    const g = gateWith();
    g.registerSession('s');
    g.setScope('s', 'Exec', 'always');
    const msg = runPermisosCommand([g], dbPath, 'revocar exec');
    expect(msg).toContain('Exec');
    expect(listAlwaysGrants(dbPath)).toEqual([]);
  });

  it('unknown subcommand and missing target print usage', () => {
    expect(runPermisosCommand([gateWith()], dbPath, 'borra todo')).toContain('Uso:');
    expect(runPermisosCommand([gateWith()], dbPath, 'revocar')).toContain('Uso:');
  });

  it('revocar kills the trust DERIVED from the approval: the same action asks again (approver path, auditor #155 r1)', async () => {
    let asked = 0;
    const gate = new Gate({
      allow: ['read'],
      dbPath,
      grantWindowMs: 90_000,
      // The daemon's real "Siempre" flow: the approver grants the scope and
      // check() then memoizes the exact call and opens the trust window.
      approver: (call) => {
        asked += 1;
        gate.setScope('s', call.tool, 'always');
        return true;
      },
    });
    gate.registerSession('s');
    const call = { tool: 'exec', args: { command: 'ls' }, actor: 'local' } as const;
    expect((await gate.check('s', call)).verdict).toBe('allow');
    expect(asked).toBe(1);
    // Same exact call: the memo waves it through WITHOUT asking.
    expect((await gate.check('s', call)).verdict).toBe('allow');
    expect(asked).toBe(1);
    const msg = runPermisosCommand([gate], dbPath, 'revocar exec');
    expect(msg).toContain('quitado');
    // After the revoke the very same action asks again: no memo, no scope.
    const again = await gate.check('s', call);
    expect(again.verdict).toBe('allow'); // the approver says yes...
    expect(asked).toBe(2); // ...but it HAD to ask
    expect(again.reason).not.toContain('previously approved');
  });

  it('revokeAlways kills the computer trust window: new clicks ask again inside 90s', async () => {
    let asked = 0;
    const gate = new Gate({
      allow: ['read'],
      dbPath,
      grantWindowMs: 90_000,
      approver: () => {
        asked += 1;
        return true;
      },
    });
    gate.registerSession('s');
    const clickA = {
      tool: 'computer',
      args: { action: 'click', x: 1, y: 1 },
      actor: 'local',
    } as const;
    const clickB = {
      tool: 'computer',
      args: { action: 'click', x: 9, y: 9 },
      actor: 'local',
    } as const;
    expect((await gate.check('s', clickA)).verdict).toBe('allow');
    expect(asked).toBe(1);
    // Different click, same tool: only the trust window can wave it through.
    const viaWindow = await gate.check('s', clickB);
    expect(viaWindow.verdict).toBe('allow');
    expect(viaWindow.reason).toContain('window');
    expect(asked).toBe(1);
    gate.revokeAlways('computer');
    await gate.check('s', clickB);
    expect(asked).toBe(2); // the window died with the grant
  });

  it('lists and revokes memory-only grants (union DB + live gates, auditor #155 r1)', () => {
    const memoryOnly = new Gate({ allow: ['read'], approver: YES }); // no dbPath
    memoryOnly.registerSession('s');
    memoryOnly.setScope('s', 'exec', 'always');
    expect(listAlwaysGrants(dbPath)).toEqual([]); // nothing on disk
    const msg = runPermisosCommand([memoryOnly], dbPath, 'estado');
    expect(msg).toContain('exec');
    const revoked = runPermisosCommand([memoryOnly], dbPath, 'revocar exec');
    expect(revoked).toContain('quitado');
    expect(memoryOnly.listPersistedAlways()).not.toContain('exec');
  });

  it('revocar una herramienta no toca el memo ni la ventana de OTRAS', async () => {
    let asked = 0;
    const gate = new Gate({
      allow: ['read'],
      dbPath,
      grantWindowMs: 90_000,
      approver: () => {
        asked += 1;
        return true;
      },
    });
    gate.registerSession('s');
    gate.setScope('s', 'exec', 'always');
    const clickA = {
      tool: 'computer',
      args: { action: 'click', x: 1, y: 1 },
      actor: 'local',
    } as const;
    const clickB = {
      tool: 'computer',
      args: { action: 'click', x: 9, y: 9 },
      actor: 'local',
    } as const;
    await gate.check('s', clickA); // approver: memo clickA + window
    expect((await gate.check('s', clickB)).reason).toContain('window');
    expect(asked).toBe(1);
    runPermisosCommand([gate], dbPath, 'revocar exec');
    // computer's memo and window survive the exec revoke:
    expect((await gate.check('s', clickA)).reason).toContain('previously approved');
    expect((await gate.check('s', clickB)).reason).toContain('window');
    expect(asked).toBe(1);
  });

  it('deleteAlwaysGrant is idempotent and reports existence', () => {
    const g = gateWith();
    g.registerSession('s');
    g.setScope('s', 'exec', 'always');
    expect(deleteAlwaysGrant(dbPath, 'exec')).toBe(true);
    expect(deleteAlwaysGrant(dbPath, 'exec')).toBe(false);
  });
});
