// La misma nota en dos chats no puede pisarse: el id del tracker no tenía scope,
// así que la segunda llamada a track() reescribía el scope de la primera y el
// primer chat perdía su pendiente (HINTS goals-2, alerts).
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { FollowupTracker } from '../src/alerts/followups.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

const T0 = 1_760_000_000_000;
const A = 'telegram:bot:111#principal';
const B = 'telegram:bot:-222#principal';

function tracker() {
  return new FollowupTracker({ db: new DatabaseSync(':memory:'), now: () => T0 });
}

describe('seguimientos por chat', () => {
  it('la misma nota en dos chats son dos notas y cada chat conserva la suya', () => {
    const t = tracker();
    const a = t.track(A, 'date', 'pagar el seguro', T0 + 1000);
    const b = t.track(B, 'date', 'pagar el seguro', T0 + 2000);
    expect(a).not.toBe(b);
    expect(t.list(A).map((f) => f.subject)).toEqual(['pagar el seguro']);
    expect(t.list(B).map((f) => f.subject)).toEqual(['pagar el seguro']);
    expect(t.list(A)[0]?.dueAt).toBe(T0 + 1000);
  });

  it('volver a apuntarla en el mismo chat actualiza la misma fila', () => {
    const t = tracker();
    const first = t.track(A, 'date', 'pagar el seguro', T0 + 1000);
    t.track(B, 'date', 'pagar el seguro', T0 + 2000);
    const again = t.track(A, 'date', 'pagar el seguro', T0 + 5000);
    expect(again).toBe(first);
    expect(t.list(A)).toHaveLength(1);
    expect(t.list(A)[0]?.dueAt).toBe(T0 + 5000);
    const otherAgain = t.track(B, 'date', 'pagar el seguro', T0 + 6000);
    expect(t.list(B)).toHaveLength(1);
    expect(otherAgain).not.toBe(first);
  });

  it('resolver la de un chat no toca la del otro', () => {
    const t = tracker();
    const a = t.track(A, 'date', 'pagar el seguro', T0 - 1000);
    t.track(B, 'date', 'pagar el seguro', T0 - 1000);
    t.resolve(a);
    expect(t.due(T0).map((f) => f.scope)).toEqual([B]);
  });

  it('summarize con chatKey solo cuenta las notas de ese chat', () => {
    const t = tracker();
    t.track(A, 'date', 'renovar el DNI', T0 - 1000);
    t.track(B, 'date', 'comprar regalo grupo', T0 - 1000);
    expect(t.summarize(T0, { chatKey: 'telegram:bot:111' })).toBe('Vence: renovar el DNI');
    expect(t.summarize(T0, { chatKey: 'telegram:bot:11' })).toBe('Todo al día.');
    expect(t.summarize(T0)).toContain('comprar regalo grupo');
  });
});
