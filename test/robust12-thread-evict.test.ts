import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evictIdleThreads } from '../src/daemon/thread-evict.js';

type T = { key: string; chatKey: string; name: string; active: boolean; createdAt: number };

const make = (n: number): Map<string, T> => {
  const threads = new Map<string, T>();
  for (let i = 0; i < n; i++) {
    const key = `tg:1#t${i}`;
    threads.set(key, { key, chatKey: 'tg:1', name: `t${i}`, active: false, createdAt: i });
  }
  return threads;
};

describe('evicción de conversaciones', () => {
  it('borra también lo guardado aparte para cada conversación expulsada', () => {
    const threads = make(23);
    const inbound = new Map<string, string>();
    const syncs = new Map<string, () => void>();
    const turns = new Map<string, { agent: object }>();
    for (const key of threads.keys()) {
      inbound.set(key, 'msg');
      syncs.set(key, () => {});
      turns.set(key, { agent: {} });
    }
    const evicted = evictIdleThreads({
      threads,
      max: 20,
      selected: () => undefined,
      perThread: [inbound, syncs, turns],
    });
    expect(evicted.map((t) => t.name)).toEqual(['t0', 't1', 't2']);
    expect(threads.size).toBe(20);
    for (const m of [inbound, syncs, turns]) {
      expect(m.size).toBe(20);
      expect(m.has('tg:1#t0')).toBe(false);
      expect(m.has('tg:1#t22')).toBe(true);
    }
  });

  it('no toca la conversación activa ni la elegida con /topic', () => {
    const threads = make(22);
    const t0 = threads.get('tg:1#t0');
    if (t0) t0.active = true;
    const evicted = evictIdleThreads({
      threads,
      max: 20,
      selected: () => 't1',
      perThread: [],
    });
    expect(evicted.map((t) => t.name)).toEqual(['t2', 't3']);
    expect(threads.has('tg:1#t0')).toBe(true);
    expect(threads.has('tg:1#t1')).toBe(true);
  });

  it('con 20 o menos no expulsa nada', () => {
    const threads = make(20);
    const inbound = new Map([['tg:1#t0', 'x']]);
    expect(
      evictIdleThreads({ threads, max: 20, selected: () => undefined, perThread: [inbound] }),
    ).toEqual([]);
    expect(inbound.size).toBe(1);
  });

  it('el daemon pasa sus mapas por conversación a la evicción', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const call = src.slice(src.indexOf('evictThreads({'), src.indexOf('evictThreads({') + 600);
    expect(call).toContain('threadInbound');
    expect(call).toContain('factorySyncs');
    expect(call).toContain('lastTurns.forget');
  });
});
