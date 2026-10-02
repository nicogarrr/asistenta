import { describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/config.js';
import { DEFAULT_RETRY, isTransientProviderError, retryDelay } from '../src/core/retry.js';

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
