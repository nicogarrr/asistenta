import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvalChatOf, Gate, runPermisosCommand } from '../src/permissions.js';

const YES = () => true;

describe('/permisos marca los «Siempre» de este chat', () => {
  let dir = '';
  let dbPath = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-permisos-este-'));
    dbPath = join(dir, 'approvals.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const grant = (chat: string, ...tools: string[]) => {
    const g = new Gate({ allow: ['read'], approver: YES, dbPath, approvalChat: chat });
    g.registerSession('s');
    for (const t of tools) g.setScope('s', t, 'always');
    return g;
  };

  it('un permiso dado solo aquí sale como «este chat»', () => {
    const a = grant('telegram:111', 'exec');
    const b = grant('telegram:222', 'fetch');
    const msg = runPermisosCommand([a, b], dbPath, '', 'telegram:111');
    expect(msg).toContain('exec (este chat)');
    expect(msg).toContain('fetch (chat telegram:222)');
  });

  it('un permiso dado aquí y en otro chat nombra los dos', () => {
    const a = grant('telegram:111', 'exec');
    const b = grant('telegram:222', 'exec');
    const msg = runPermisosCommand([a, b], dbPath, 'estado', 'telegram:222');
    expect(msg).toContain('exec (este chat y chat telegram:111)');
  });

  it('el chat de un hilo `chat#hilo` es el mismo chat', () => {
    const a = grant(approvalChatOf('telegram:111#trabajo'), 'exec');
    expect(runPermisosCommand([a], dbPath, '', approvalChatOf('telegram:111#otro'))).toContain(
      'exec (este chat)',
    );
  });

  it('sin chat actual el listado no cambia (caracterización)', () => {
    const a = grant('telegram:111', 'exec');
    expect(runPermisosCommand([a], dbPath, '')).toContain('exec (chat telegram:111)');
  });
});
