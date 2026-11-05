import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { isOutageError } from '../src/core/friendly-error.js';
import {
  AUTO_RETRY_DELAYS_MS,
  AUTO_RETRY_GAVE_UP,
  AutoRetries,
  autoRetryNote,
  retryDelayText,
} from '../src/daemon/auto-retry.js';
import { envSwitchOn } from '../src/env-flags.js';

describe('reintento automático sin red o con el modelo caído', () => {
  it('solo cuenta como caída lo que se arregla esperando', () => {
    for (const raw of [
      'TypeError: fetch failed',
      'getaddrinfo ENOTFOUND opencode.ai',
      'connect ECONNREFUSED 127.0.0.1:4096',
      '503 Service Unavailable',
      '429 rate limit exceeded',
      'Request timed out',
      'upstream overloaded',
    ]) {
      expect(isOutageError(raw), raw).toBe(true);
    }
    for (const raw of [
      '401 Unauthorized',
      'invalid api key',
      '402 insufficient funds',
      'context length exceeded',
      'Te detuve porque ibas a borrar algo',
      'Cannot read properties of undefined',
      '',
      null,
    ]) {
      expect(isOutageError(raw), String(raw)).toBe(false);
    }
  });

  it('reintenta tras 1, 2, 5, 10 y 15 min y luego se rinde', async () => {
    expect(AUTO_RETRY_DELAYS_MS).toEqual([60_000, 120_000, 300_000, 600_000, 900_000]);
    vi.useFakeTimers();
    try {
      const r = new AutoRetries();
      const run = vi.fn();
      expect(r.schedule('chat', 0, run)).toBe(60_000);
      vi.advanceTimersByTime(59_999);
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      expect(run).toHaveBeenCalledTimes(1);
      expect(r.pending('chat')).toBe(false);
      expect(r.schedule('chat', 4, run)).toBe(900_000);
      expect(r.schedule('chat', 5, run)).toBeNull();
      expect(r.pending('chat')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('un mensaje nuevo cancela el reintento pendiente y no se acumulan', async () => {
    vi.useFakeTimers();
    try {
      const r = new AutoRetries();
      const first = vi.fn();
      const second = vi.fn();
      r.schedule('a', 0, first);
      r.schedule('a', 1, second);
      expect(r.size).toBe(1);
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect(first).not.toHaveBeenCalled();
      expect(r.cancel('a')).toBe(true);
      vi.advanceTimersByTime(600_000);
      await Promise.resolve();
      expect(second).not.toHaveBeenCalled();
      expect(r.cancel('a')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('un reintento que lanza no tumba el daemon', async () => {
    vi.useFakeTimers();
    try {
      const r = new AutoRetries({ delays: [10] });
      r.schedule('a', 0, () => Promise.reject(new Error('boom')));
      vi.advanceTimersByTime(10);
      await Promise.resolve();
      await Promise.resolve();
      expect(r.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('avisa en castellano y con la espera', () => {
    expect(retryDelayText(60_000)).toBe('1 min');
    expect(retryDelayText(900_000)).toBe('15 min');
    expect(retryDelayText(30_000)).toBe('30 s');
    expect(autoRetryNote(60_000)).toContain('Lo vuelvo a intentar yo solo en 1 min');
    expect(AUTO_RETRY_GAVE_UP).toContain('/reintentar');
  });

  it('está encendido por defecto y PA_AUTO_RETRY=0 lo apaga', () => {
    expect(envSwitchOn('PA_AUTO_RETRY', {})).toBe(true);
    expect(envSwitchOn('PA_AUTO_RETRY', { PA_AUTO_RETRY: 'no' })).toBe(false);
    expect(readFileSync('.env.example', 'utf8')).toContain('PA_AUTO_RETRY');
  });

  it('el chat de Telegram lo usa: cancela con un mensaje nuevo y reintenta en silencio', () => {
    const cli = readFileSync('src/cli.ts', 'utf8');
    expect(cli).toMatch(
      /if \(opts\.autoRetry === undefined && !opts\.external\) autoRetries\.cancel\(thread\.key\);/,
    );
    expect(cli).toMatch(/isOutageError\(result\.error\)/);
    expect(cli).toMatch(/autoRetryTurn\(thread, inbound, generation, attempt\)/);
    expect(cli).toMatch(/else if \(text2\) await answer\(thread, inbound, text2\);/);
  });
});
