import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Gate, runPermisosCommand } from '../src/permissions.js';

const YES = () => true;

describe('/permisos revocar <herramienta> este chat', () => {
  let dir = '';
  let dbPath = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-permisos-revocar-aqui-'));
    dbPath = join(dir, 'approvals.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const grant = (chat: string, ...tools: string[]) => {
    const g = new Gate({ allow: ['read'], approver: YES, dbPath, approvalChat: chat });
    g.registerSession('s');
    for (const t of tools) g.setScope('s', t, 'always');
    return g;
  };

  it('quita el «Siempre» solo en este chat (DB y memoria) y deja el del otro', () => {
    const a = grant('telegram:111', 'exec');
    const b = grant('telegram:222', 'exec');
    const msg = runPermisosCommand([a, b], dbPath, 'revocar exec este chat', 'telegram:111');
    expect(msg).toContain('quitado en este chat');
    expect(msg).toContain('Sigue valiendo en otros chats para: exec');
    const list = runPermisosCommand([a, b], dbPath, '', 'telegram:111');
    expect(list).toContain('exec (chat telegram:222)');
    expect(list).not.toContain('este chat y');
    expect(a.listPersistedAlwaysWithChat().filter((r) => r.chat === 'telegram:111')).toEqual([]);
  });

  it('«todo este chat» quita todos los de aquí y ninguno de fuera', () => {
    const a = grant('telegram:111', 'exec', 'fetch');
    const b = grant('telegram:222', 'fetch');
    const msg = runPermisosCommand([a, b], dbPath, 'revocar todo este chat', 'telegram:111');
    expect(msg).toContain('exec, fetch quitado en este chat');
    expect(runPermisosCommand([a, b], dbPath, '', 'telegram:111')).toContain(
      'Permisos "siempre" activos (1): fetch (chat telegram:222)',
    );
  });

  it('sin chat actual no quita nada', () => {
    const a = grant('telegram:111', 'exec');
    const msg = runPermisosCommand([a], dbPath, 'revocar exec este chat');
    expect(msg).toContain('no he quitado nada');
    expect(runPermisosCommand([a], dbPath, '')).toContain('exec (chat telegram:111)');
  });

  it('una herramienta sin «Siempre» aquí no toca la de otro chat', () => {
    const b = grant('telegram:222', 'exec');
    const msg = runPermisosCommand([b], dbPath, 'revocar exec este chat', 'telegram:111');
    expect(msg).toContain('No había un permiso "siempre" para exec en este chat');
    expect(runPermisosCommand([b], dbPath, '', 'telegram:111')).toContain(
      'exec (chat telegram:222)',
    );
  });

  it('revocar sin «este chat» sigue quitándolo en todos (caracterización)', () => {
    const a = grant('telegram:111', 'exec');
    const b = grant('telegram:222', 'exec');
    runPermisosCommand([a, b], dbPath, 'revocar exec', 'telegram:111');
    expect(runPermisosCommand([a, b], dbPath, '')).toContain('ningún permiso');
  });
});
