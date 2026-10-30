// La agenda y el resumen semanal de un chat enseñaban los pendientes de todos
// los chats: /agenda en un grupo mostraba lo que Nico apuntó en privado.

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { FollowupTracker } from '../src/alerts/followups.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const T0 = 1_760_000_000_000;

describe('seguimientos de un solo chat', () => {
  it('forChat devuelve todos los hilos del chat y nada de otros chats', () => {
    let now = T0;
    const t = new FollowupTracker({ db: new DatabaseSync(':memory:'), now: () => now++ });
    t.track('telegram:bot:12#principal', 'date', 'privado de Nico', T0 + 1000);
    t.track('telegram:bot:12#hilo-viaje', 'date', 'reservar hotel', T0 + 2000);
    t.track('telegram:bot:123#principal', 'date', 'otro chat con prefijo parecido', T0 + 3000);
    t.track('telegram:bot:-500#principal', 'date', 'grupo', T0 + 4000);
    expect(t.forChat('telegram:bot:12').map((f) => f.subject)).toEqual([
      'reservar hotel',
      'privado de Nico',
    ]);
    expect(t.forChat('telegram:bot:-500').map((f) => f.subject)).toEqual(['grupo']);
    expect(t.forChat('telegram:bot:999')).toEqual([]);
  });

  it('el daemon usa el chat en /agenda y en el resumen semanal', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('followups: () => followups.forChat(chatKey(inbound), 200)');
    const weekly = cli.slice(
      cli.indexOf('const weeklyText = '),
      cli.indexOf('const sendWeeklyIfDue'),
    );
    expect(weekly).toMatch(/followups\.summarize\(Date\.now\(\), \{\s*chatKey:/);
  });
});
