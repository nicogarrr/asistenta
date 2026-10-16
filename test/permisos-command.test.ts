import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Gate,
  deleteAlwaysGrant,
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

  it('deleteAlwaysGrant is idempotent and reports existence', () => {
    const g = gateWith();
    g.registerSession('s');
    g.setScope('s', 'exec', 'always');
    expect(deleteAlwaysGrant(dbPath, 'exec')).toBe(true);
    expect(deleteAlwaysGrant(dbPath, 'exec')).toBe(false);
  });
});
