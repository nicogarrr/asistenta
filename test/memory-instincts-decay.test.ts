import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstinctStore, RULE_THRESHOLD } from '../src/memory/instincts.js';

const DAY = 86_400_000;

function storeWithRule(times = RULE_THRESHOLD): { store: InstinctStore; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  const store = new InstinctStore({ db });
  for (let i = 0; i < times; i++) store.observe('respuestas cortas', 'pref');
  return { store, db };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('instintos: el olvido no depende de cuántas veces se reinicia', () => {
  it('diez arranques el mismo día quitan un solo punto', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    const { store } = storeWithRule();
    vi.setSystemTime(new Date('2026-04-15T10:00:00Z')); // > 90 días sin verse
    for (let i = 0; i < 10; i++) {
      store.decay(90);
      vi.advanceTimersByTime(10 * 60_000);
    }
    expect(store.suggest()[0]?.confidence).toBe(RULE_THRESHOLD - 1);
  });

  it('al día siguiente vuelve a contar', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    const { store } = storeWithRule();
    vi.setSystemTime(new Date('2026-04-15T10:00:00Z'));
    expect(store.decay(90)).toBe(1);
    expect(store.decay(90)).toBe(0);
    vi.advanceTimersByTime(DAY);
    expect(store.decay(90)).toBe(1);
    expect(store.suggest()[0]?.confidence).toBe(RULE_THRESHOLD - 2);
  });

  it('un patrón visto hace poco no pierde nada', () => {
    const { store } = storeWithRule(6);
    expect(store.decay(90)).toBe(0);
    expect(store.suggest()[0]?.confidence).toBe(6);
  });
});

describe('instintos: confirmar no rebaja', () => {
  it('promote no baja un patrón que ya pasaba de la regla', () => {
    const { store } = storeWithRule(RULE_THRESHOLD + 5);
    const id = store.rules()[0]?.id as string;
    store.promote(id);
    expect(store.rules()[0]?.confidence).toBe(RULE_THRESHOLD + 5);
  });

  it('confirmar cuenta como visto: la siguiente pasada no le quita el punto', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
    const { store, db } = storeWithRule(3);
    const row = db.prepare('SELECT id FROM instincts').get() as { id: string };
    vi.setSystemTime(new Date('2026-06-01T10:00:00Z'));
    store.promote(row.id);
    store.decay(90);
    expect(store.rules()[0]?.confidence).toBe(RULE_THRESHOLD);
  });
});
