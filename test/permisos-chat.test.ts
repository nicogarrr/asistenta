import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as perms from '../src/permissions.js';
import { Gate, runPermisosCommand } from '../src/permissions.js';

const YES = () => true;

describe('/permisos dice en qué chat vale cada «Siempre»', () => {
  let dir = '';
  let dbPath = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-permisos-chat-'));
    dbPath = join(dir, 'approvals.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const gateIn = (chat: string) =>
    new Gate({ allow: ['read'], approver: YES, dbPath, approvalChat: chat });

  it('listAlwaysGrantsWithChat devuelve herramienta y chat de cada fila', () => {
    const a = gateIn('telegram:111');
    a.registerSession('s');
    a.setScope('s', 'exec', 'always');
    const b = gateIn('telegram:222');
    b.registerSession('s');
    b.setScope('s', 'exec', 'always');
    b.setScope('s', 'fetch', 'always');
    const fn = (perms as Record<string, unknown>).listAlwaysGrantsWithChat as (
      p: string,
    ) => Array<{ tool: string; chat: string }>;
    expect(typeof fn).toBe('function');
    expect(fn(dbPath)).toEqual([
      { tool: 'exec', chat: 'telegram:111' },
      { tool: 'exec', chat: 'telegram:222' },
      { tool: 'fetch', chat: 'telegram:222' },
    ]);
    expect(fn(undefined as unknown as string)).toEqual([]);
  });

  it('el listado nombra el chat de cada permiso', () => {
    const a = gateIn('telegram:111');
    a.registerSession('s');
    a.setScope('s', 'exec', 'always');
    const b = gateIn('telegram:222');
    b.registerSession('s');
    b.setScope('s', 'exec', 'always');
    b.setScope('s', 'fetch', 'always');
    const msg = runPermisosCommand([a, b], dbPath, '');
    expect(msg).toContain('(2)');
    expect(msg).toContain('exec (chats telegram:111, telegram:222)');
    expect(msg).toContain('fetch (chat telegram:222)');
    expect(msg).toContain('solo en el chat donde lo diste');
  });

  it('un «Siempre» solo en memoria (gate sin base de datos) sale con su chat', () => {
    const g = new Gate({ allow: ['read'], approver: YES, approvalChat: 'telegram:333' });
    g.registerSession('s');
    g.setScope('s', 'exec', 'always');
    const msg = runPermisosCommand([g], undefined, 'estado');
    expect(msg).toContain('exec (chat telegram:333)');
  });

  it('la consola local se nombra como tal', () => {
    const g = new Gate({ allow: ['read'], approver: YES, dbPath });
    g.registerSession('s');
    g.setScope('s', 'exec', 'always');
    expect(runPermisosCommand([g], dbPath, '')).toContain('exec (chat local (consola))');
  });

  it('revocar sigue quitando la herramienta en todos los chats', () => {
    const a = gateIn('telegram:111');
    a.registerSession('s');
    a.setScope('s', 'exec', 'always');
    const b = gateIn('telegram:222');
    b.registerSession('s');
    b.setScope('s', 'exec', 'always');
    runPermisosCommand([a, b], dbPath, 'revocar exec');
    expect(runPermisosCommand([a, b], dbPath, '')).toContain('ningún permiso');
  });
});
