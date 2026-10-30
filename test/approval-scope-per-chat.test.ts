import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvalChatOf, deleteAlwaysGrant, Gate, listAlwaysGrants } from '../src/permissions.js';

// «Siempre» vale solo en el chat donde se dio. Antes approval_scopes no guardaba
// el chat y un permiso dado en el privado de Nico valía en cualquier grupo.
describe('«Siempre» por chat', () => {
  let dir: string;
  let db: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-scope-chat-'));
    db = join(dir, 'approvals.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const gate = (chat?: string) => new Gate({ dbPath: db, approvalChat: chat });

  it('un «Siempre» de un chat no vale en otro chat', () => {
    gate('telegram:dm:1').setScope('telegram:dm:1#main', 'fetch', 'always');
    expect(gate('telegram:dm:1').scopeFor('telegram:dm:1#otro', 'fetch')).toBe('always');
    expect(gate('telegram:group:-5').scopeFor('telegram:group:-5#main', 'fetch')).toBe('unset');
    expect(gate().scopeFor('local', 'fetch')).toBe('unset');
  });

  it('una fila antigua sin chat no vale en ningún chat', () => {
    const raw = new DatabaseSync(db);
    raw.exec(
      'CREATE TABLE approval_scopes (scope_key TEXT PRIMARY KEY, tool TEXT, level TEXT, created_at INTEGER)',
    );
    raw
      .prepare('INSERT INTO approval_scopes VALUES (?, ?, ?, ?)')
      .run('always:fetch', 'fetch', 'always', 1);
    raw.close();
    expect(gate('telegram:dm:1').scopeFor('telegram:dm:1#main', 'fetch')).toBe('unset');
    expect(gate().scopeFor('local', 'fetch')).toBe('unset');
    expect(listAlwaysGrants(db)).toEqual([]);
  });

  it('aprobar lo mismo en dos chats guarda dos permisos; revocar quita ambos', () => {
    gate('a').setScope('a#main', 'fetch', 'always');
    gate('b').setScope('b#main', 'fetch', 'always');
    expect(gate('a').scopeFor('a#main', 'fetch')).toBe('always');
    expect(gate('b').scopeFor('b#main', 'fetch')).toBe('always');
    gate('b').setScope('b#main', 'fetch', 'once');
    expect(gate('a').scopeFor('a#main', 'fetch')).toBe('always');
    expect(gate('b').scopeFor('b#main', 'fetch')).toBe('unset');
    expect(listAlwaysGrants(db)).toEqual(['fetch']);
    expect(deleteAlwaysGrant(db, 'fetch')).toBe(true);
    expect(gate('a').scopeFor('a#main', 'fetch')).toBe('unset');
  });

  it('el chat de un hilo es lo que va antes del último #', () => {
    expect(approvalChatOf('telegram:dm:1#main')).toBe('telegram:dm:1');
    expect(approvalChatOf('x#y#z')).toBe('x#y');
    expect(approvalChatOf('local')).toBe('local');
  });
});
