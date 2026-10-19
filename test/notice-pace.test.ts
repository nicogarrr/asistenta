import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import {
  currentLimits,
  getPace,
  PACE_LIMITS,
  parsePace,
  recordDismissal,
  setPace,
} from '../src/notice-pace.js';
import { ATTENTION_LIMITS, AttentionQueue } from '../src/ojo-events.js';
import {
  ASK_TOOL_NAME,
  createAskTool,
  extractDoneSummary,
  isTerminalToolName,
} from '../src/tools/done.js';

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
const mk = () => {
  const d = new DatabaseSync(':memory:');
  dbs.push(d);
  return d;
};
const T0 = Date.UTC(2026, 9, 18, 10);

it('pace defaults to normal and never exceeds the reviewed base limits', () => {
  const db = mk();
  expect(getPace(db)).toBe('normal');
  expect(currentLimits(db)).toEqual({
    noticesPerDay: ATTENTION_LIMITS.noticesPerDay,
    cooldownMs: ATTENTION_LIMITS.cooldownMs,
  });
  for (const l of Object.values(PACE_LIMITS)) {
    expect(l.noticesPerDay).toBeLessThanOrEqual(ATTENTION_LIMITS.noticesPerDay);
    expect(l.cooldownMs).toBeGreaterThanOrEqual(ATTENTION_LIMITS.cooldownMs);
  }
});

it('parses Spanish arguments with accents and rejects the rest', () => {
  expect(parsePace('')).toBe('estado');
  expect(parsePace('Menos')).toBe('menos');
  expect(parsePace('mínimo')).toBe('minimo');
  expect(parsePace('más')).toBe('normal');
  expect(parsePace('mucho más')).toBeNull();
});

it('three dismissals in 48h step down one level; older ones do not count; floor holds', () => {
  const db = mk();
  expect(recordDismissal(db, T0)).toBeNull();
  expect(recordDismissal(db, T0 + 1000)).toBeNull();
  expect(recordDismissal(db, T0 + 2000)).toBe('menos');
  expect(getPace(db)).toBe('menos');
  // counter reset after a step; stale dismissals fall out of the window
  recordDismissal(db, T0 + 3000);
  recordDismissal(db, T0 + 3_000_000_000);
  expect(recordDismissal(db, T0 + 3_000_000_100)).toBeNull();
  for (let i = 0; i < 3; i++) recordDismissal(db, T0 + 4_000_000_000 + i);
  expect(getPace(db)).toBe('minimo');
  for (let i = 0; i < 6; i++) expect(recordDismissal(db, T0 + 5_000_000_000 + i)).toBeNull();
  expect(getPace(db)).toBe('minimo');
  setPace(db, 'normal');
  expect(getPace(db)).toBe('normal');
});

it('queue honours a stricter pace but clamps a looser one to the base limit', async () => {
  const event = (n: number) => ({
    source: 'mail' as const,
    id: `a:${n}`,
    text: 'Pedido duplicado confirmado en el recibo',
    at: T0,
  });
  const yes = JSON.stringify({
    relevant: true,
    score: 0.95,
    evidence: 'Pedido duplicado confirmado',
  });
  const run = async (pace: () => { noticesPerDay: number; cooldownMs: number }) => {
    const db = mk();
    let now = T0;
    const send = vi.fn(async () => true);
    const q = new AttentionQueue({
      db,
      now: () => now,
      timeZone: 'Europe/Madrid',
      enabled: () => true,
      judge: async () => yes,
      send,
      pace,
    });
    for (let i = 0; i < 6; i++) {
      await q.offer([event(i)]);
      now += 9 * 3_600_000; // beyond any cooldown; stays inside the 24h window only partly
      if (now > T0 + 12 * 3_600_000) now = T0 + 12 * 3_600_000 + i; // keep daytime
    }
    return send.mock.calls.length;
  };
  const strict = await run(() => PACE_LIMITS.minimo);
  expect(strict).toBe(1);
  const loose = await run(() => ({ noticesPerDay: 99, cooldownMs: 0 }));
  expect(loose).toBeLessThanOrEqual(ATTENTION_LIMITS.noticesPerDay);
});

it('ask tool ends the run with the question and counts as terminal', async () => {
  const tool = createAskTool();
  expect(tool.name).toBe(ASK_TOOL_NAME);
  expect(isTerminalToolName('preguntar')).toBe(true);
  expect(isTerminalToolName('done')).toBe(true);
  expect(isTerminalToolName('shell')).toBe(false);
  const res = await tool.execute(
    '1',
    { question: '  ¿A Ana López o a Ana Pérez?  ' },
    undefined as never,
  );
  expect(res.terminate).toBe(true);
  expect(extractDoneSummary(res)).toBe('¿A Ana López o a Ana Pérez?');
  await expect(tool.execute('2', { question: '   ' }, undefined as never)).rejects.toThrow();
});
