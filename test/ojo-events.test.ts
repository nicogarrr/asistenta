import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { attentionFreeConfig } from '../src/core/attention-model.js';
import {
  type AttentionDeps,
  type AttentionEvent,
  AttentionQueue,
  parseAttention,
} from '../src/ojo-events.js';

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const event: AttentionEvent = {
  source: 'mail',
  id: 'account:inbox:1',
  text: 'Pedido duplicado confirmado en el recibo',
  at: Date.UTC(2026, 9, 18, 10),
};
const yes = JSON.stringify({
  relevant: true,
  score: 0.95,
  evidence: 'Pedido duplicado confirmado',
});
function setup(over: Partial<AttentionDeps> = {}) {
  const db = new DatabaseSync(':memory:');
  dbs.push(db);
  const judge = vi.fn(async () => yes);
  const send = vi.fn(async (_text: string) => true);
  const deps: AttentionDeps = {
    db,
    now: () => event.at,
    timeZone: 'Europe/Madrid',
    enabled: () => true,
    judge,
    send,
    ...over,
  };
  return { queue: new AttentionQueue(deps), db, judge, send, deps };
}
it('two stages only for relevant event, dedup across concurrent offers and restarts', async () => {
  const s = setup();
  await Promise.all([s.queue.offer([event]), s.queue.offer([event])]);
  await new AttentionQueue(s.deps).offer([event]);
  expect(s.judge).toHaveBeenCalledTimes(2);
  expect(s.judge.mock.calls.map((c: unknown[]) => c[0])).toEqual(['screen', 'review']);
  expect(s.send).toHaveBeenCalledTimes(1);
  expect(s.send.mock.calls[0]?.[0]).toContain('no un error confirmado');
  expect(s.db.prepare('SELECT payload FROM attention_events').get()).toEqual(
    expect.objectContaining({ payload: '' }),
  );
});
it('irrelevant screen never wakes review', async () => {
  const judge = vi.fn(async () => JSON.stringify({ relevant: false, score: 1 }));
  const s = setup({ judge });
  await s.queue.offer([event]);
  expect(judge).toHaveBeenCalledTimes(1);
  expect(s.send).not.toHaveBeenCalled();
});
it('quiet hours defer with no model calls, later delivery drains', async () => {
  let now = Date.UTC(2026, 9, 18, 21);
  const s = setup({ now: () => now });
  await s.queue.offer([{ ...event, at: now }]);
  expect(s.judge).not.toHaveBeenCalled();
  now = Date.UTC(2026, 9, 19, 7);
  await s.queue.offer([]);
  expect(s.send).toHaveBeenCalledOnce();
});
it('off and stopped have no model or send effects', async () => {
  const s = setup({ enabled: () => false });
  await s.queue.offer([event]);
  expect(s.judge).not.toHaveBeenCalled();
  await s.queue.stop();
  await s.queue.offer([event]);
  expect(s.send).not.toHaveBeenCalled();
});
it('cooldown and daily cap survive restarts', async () => {
  let now = event.at;
  const s = setup({ now: () => now });
  for (let i = 0; i < 6; i++) {
    await new AttentionQueue(s.deps).offer([{ ...event, id: String(i), at: now }]);
    now += 31 * 60_000;
  }
  expect(s.send).toHaveBeenCalledTimes(4);
});
it('failed ambiguous send is not retried or duplicated', async () => {
  const send = vi.fn(async () => {
    throw new Error('ambiguous');
  });
  const s = setup({ send });
  await s.queue.offer([event]);
  await s.queue.offer([event]);
  expect(send).toHaveBeenCalledTimes(1);
});
it('errors consume model quota and cannot crash source delivery', async () => {
  const judge = vi.fn(async () => {
    throw new Error('quota');
  });
  const s = setup({ judge });
  for (let i = 0; i < 30; i++) await s.queue.offer([event]);
  expect(judge.mock.calls.length).toBeLessThanOrEqual(20);
  expect(s.send).not.toHaveBeenCalled();
});
it('strict evidence rejects invented facts and invalid scores', () => {
  for (const score of [0.84, 1.01, -1, null, '0.99'])
    expect(
      parseAttention(
        JSON.stringify({ relevant: true, score, evidence: 'Pedido duplicado confirmado' }),
        event,
      ),
    ).toBeNull();
  expect(
    parseAttention(
      JSON.stringify({ relevant: true, score: 1, evidence: 'Talla incorrecta' }),
      event,
    ),
  ).toBeNull();
});
it('no paid, arbitrary endpoint or mismatched free fallback is ever enabled', () => {
  const base = loadConfig();
  expect(
    attentionFreeConfig({
      ...base,
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'model:free',
      fallbackModel: undefined,
    }),
  ).toBe(true);
  for (const model of ['paid', 'free-ish'])
    expect(
      attentionFreeConfig({
        ...base,
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model,
        fallbackModel: undefined,
      }),
    ).toBe(false);
  expect(
    attentionFreeConfig({
      ...base,
      provider: 'openrouter',
      baseUrl: 'https://evil.test/api/v1',
      model: 'model:free',
    }),
  ).toBe(false);
  expect(
    attentionFreeConfig({
      ...base,
      provider: 'opencode-local',
      baseUrl: 'http://127.0.0.1:4096',
      model: 'small-free',
      fallbackModel: 'paid',
    }),
  ).toBe(false);
});
it('malformed model JSON does not retry or escalate', async () => {
  const judge = vi.fn(async () => 'not JSON');
  const s = setup({ judge });
  await s.queue.offer([event]);
  await s.queue.offer([event]);
  expect(judge).toHaveBeenCalledOnce();
  expect(s.send).not.toHaveBeenCalled();
});
it('stopping aborts a stuck model and drains without waiting for its promise', async () => {
  let began: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const s = setup({
    judge: async () => {
      began();
      return new Promise<string>(() => {});
    },
  });
  const offered = s.queue.offer([event]);
  await started;
  await s.queue.stop();
  await offered;
  expect(s.send).not.toHaveBeenCalled();
});
it('stale and future events never reach models', async () => {
  const s = setup();
  await s.queue.offer([
    { ...event, at: event.at - 2 * 86_400_000 },
    { ...event, id: 'future', at: event.at + 2 * 86_400_000 },
  ]);
  expect(s.judge).not.toHaveBeenCalled();
});
it('transport acceptance is durable and false when off or queue refused event', async () => {
  const s = setup();
  expect(s.queue.accepted(event)).toBe(false);
  await s.queue.offer([event]);
  expect(s.queue.accepted(event)).toBe(true);
  const off = setup({ enabled: () => false });
  await off.queue.offer([event]);
  expect(off.queue.accepted(event)).toBe(false);
});

it('events offer() discards for validation count as accepted so cursors advance', () => {
  const s = setup();
  expect(s.queue.accepted({ ...event, text: '   ' })).toBe(true);
  expect(s.queue.accepted({ ...event, id: '' })).toBe(true);
  expect(s.queue.accepted({ ...event, at: Number.NaN })).toBe(true);
  expect(s.queue.accepted({ ...event, id: 'f', at: event.at + 2 * 86_400_000 })).toBe(true);
});
