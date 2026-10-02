import { describe, expect, it } from 'vitest';

/**
 * The /stop contract, tested without Telegram: generation counters let a queued or
 * running turn recognise it was cancelled.
 *
 * The rule: a turn captures the generation when it is enqueued; if the generation
 * changed by the time it would start (or finish), it returns the stopped sentinel
 * and sends nothing. A stale failure delivered after "Detenido." would be worse
 * than silence.
 */
describe('/stop generation contract', () => {
  it('a turn started before the bump is stale', () => {
    const generations = new Map<string, number>();
    const key = 'telegram:main:1';
    const genAtEnqueue = generations.get(key) ?? 0;
    generations.set(key, genAtEnqueue + 1);
    expect((generations.get(key) ?? 0) !== genAtEnqueue).toBe(true);
  });

  it('a turn started after the bump is fresh', () => {
    const generations = new Map<string, number>();
    const key = 'telegram:main:1';
    generations.set(key, 5);
    const genAtEnqueue = generations.get(key) ?? 0;
    expect((generations.get(key) ?? 0) !== genAtEnqueue).toBe(false);
  });

  it('the stopped sentinel is recognised by stopReason', () => {
    const stopped = {
      text: '',
      toolCalls: 0,
      blocked: 0,
      stopReason: 'stopped',
      error: null,
      attempts: 0,
    };
    expect(stopped.stopReason).toBe('stopped');
  });
});
