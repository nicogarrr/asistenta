import { describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';
import {
  DEFAULT_RETRY,
  isQuotaError,
  isTransientProviderError,
  pickFallbackModel,
  retryDelay,
} from '../src/core/retry.js';

describe('isTransientProviderError', () => {
  it('recognises the errors Zen actually returns', () => {
    // Captured from real runs against space-bunny-free.
    const seen = [
      '400: {"type":"invalid_request_error","message":"Upstream request failed: [invalid_request_error] invalid request"}',
      '500: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}',
      'Requested timed out',
    ];
    for (const message of seen) {
      expect(isTransientProviderError(message), message).toBe(true);
    }
  });

  it('does not retry a genuinely permanent failure', () => {
    // Looping these wastes minutes and never helps.
    for (const message of [
      '401 invalid api key',
      'This model exceeds the maximum context length',
      '402 insufficient account funds',
      '404 model not found',
      'content filter triggered',
    ]) {
      expect(isTransientProviderError(message), message).toBe(false);
    }
  });

  it('treats an unknown error as permanent', () => {
    // Conservative by design: better a failed turn than an infinite retry loop.
    expect(isTransientProviderError('something nobody has seen before')).toBe(false);
    expect(isTransientProviderError(null)).toBe(false);
    expect(isTransientProviderError(undefined)).toBe(false);
    expect(isTransientProviderError('')).toBe(false);
  });

  it('prefers the permanent signal when a message contains both', () => {
    expect(isTransientProviderError('500 upstream failed: invalid api key')).toBe(false);
  });
});

describe('retryDelay', () => {
  it('stays inside the ceiling and grows with the attempt', () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      for (let i = 0; i < 50; i++) {
        const delay = retryDelay(attempt, DEFAULT_RETRY);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(
          Math.min(DEFAULT_RETRY.maxDelayMs, DEFAULT_RETRY.baseDelayMs * 2 ** attempt),
        );
      }
    }
  });

  it('jitters rather than returning a fixed delay', () => {
    // Full jitter: a fixed backoff synchronises every client onto the same provider.
    const seen = new Set(Array.from({ length: 30 }, () => retryDelay(3, DEFAULT_RETRY)));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('config retry', () => {
  it('defaults to three attempts', () => {
    resetConfigForTests();
    const previous = { ...process.env };
    delete process.env.PA_RETRY_ATTEMPTS;
    try {
      expect(loadConfig().retry.attempts).toBe(3);
    } finally {
      process.env = previous;
      resetConfigForTests();
    }
  });

  it('rejects a nonsensical retry count', () => {
    resetConfigForTests();
    const previous = process.env.PA_RETRY_ATTEMPTS;
    process.env.PA_RETRY_ATTEMPTS = '0';
    try {
      expect(() => loadConfig()).toThrow(/positive number/);
    } finally {
      if (previous === undefined) delete process.env.PA_RETRY_ATTEMPTS;
      else process.env.PA_RETRY_ATTEMPTS = previous;
      resetConfigForTests();
    }
  });
});

describe('isQuotaError', () => {
  it('matches the quota failures free tiers actually return', () => {
    const seen = [
      '429: {"type":"rate_limit_error","message":"Rate limit exceeded"}',
      'FreeTierError: daily quota exhausted',
      'HTTP 429 too many requests',
    ];
    for (const m of seen) expect(isQuotaError(m)).toBe(true);
  });

  it('never calls a permanent error a quota error, even with quota words', () => {
    for (const m of [
      '401 invalid api key',
      '402 insufficient funds: quota exceeded',
      'model not found: 404',
    ]) {
      expect(isQuotaError(m)).toBe(false);
    }
  });

  it('leaves timeouts and 5xx to same-model retries', () => {
    for (const m of ['Requested timed out', '500 Endpoint is unavailable', 'socket hang up']) {
      expect(isQuotaError(m)).toBe(false);
    }
  });

  it('treats null, undefined and empty as no error', () => {
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
    expect(isQuotaError('')).toBe(false);
  });
});

describe('pickFallbackModel', () => {
  it('defaults to space-bunny-free only on the opencode-local preset', () => {
    expect(pickFallbackModel('opencode-local', undefined, 'deepseek-v4.1-flash-free')).toBe(
      'space-bunny-free',
    );
    expect(pickFallbackModel('opencode', undefined, 'space-bunny-free')).toBeUndefined();
    expect(pickFallbackModel('openrouter', undefined, 'x')).toBeUndefined();
  });

  it('lets the env value win on any preset', () => {
    expect(pickFallbackModel('opencode', 'gemini-2.0-flash-free:free', 'x')).toBe(
      'gemini-2.0-flash-free:free',
    );
  });

  it('never falls back to the model that just failed', () => {
    expect(pickFallbackModel('opencode-local', undefined, 'space-bunny-free')).toBeUndefined();
    expect(
      pickFallbackModel('opencode-local', 'deepseek-v4.1-flash-free', 'deepseek-v4.1-flash-free'),
    ).toBeUndefined();
  });
});

import { retryRecoveryNote } from '../src/core/retry.js';

describe('retryRecoveryNote', () => {
  it('vacío si nada se ejecutó: un reintento simple no cambia el prompt', () => {
    expect(retryRecoveryNote([])).toBe('');
  });

  it('lista lo ya ejecutado y exige comprobar antes de repetir un efecto externo', () => {
    const note = retryRecoveryNote([
      { tool: 'telegram', action: 'send', ok: true },
      { tool: 'browser', action: 'click', ok: false },
    ]);
    expect(note).toContain('telegram send: termino sin error');
    expect(note).toContain('browser click: dio error (pudo tener efecto parcial)');
    expect(note).toMatch(/YA se ejecutaron/);
    expect(note).toMatch(/comprueba el estado actual/);
  });

  it('acota la lista y cuenta las omitidas', () => {
    const steps = Array.from({ length: 20 }, (_, i) => ({ tool: 't', action: `a${i}`, ok: true }));
    const note = retryRecoveryNote(steps, 5);
    expect(note).toContain('(+15 anteriores)');
    expect(note).toContain('t a19');
    expect(note).not.toContain('t a0:');
  });
});
