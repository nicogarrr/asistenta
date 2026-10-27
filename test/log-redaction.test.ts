import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('../src/paths.js', () => ({
  paths: {
    get log() {
      return state.dir;
    },
  },
}));

import { log, redact, scrubLogText } from '../src/log.js';

state.dir = mkdtempSync(join(tmpdir(), 'pa-log-redaction-'));
afterAll(() => rmSync(state.dir, { recursive: true, force: true }));

// All credential-shaped fixtures are synthetic and have no external authority.
const canary = 'ghp_SYNTHETIC_ONLY_1234567890';
const pat = 'github_pat_SYNTHETIC_ONLY_1234567890';

describe('logger final secret boundary', () => {
  it('scrubs tokens embedded in errors, not only at the start of a field', () => {
    expect(scrubLogText(`provider rejected ${canary} and ${pat}`)).toBe(
      'provider rejected [redacted] and [redacted]',
    );
    expect(scrubLogText('request Bearer syntheticValue== failed')).toBe(
      'request Bearer [redacted] failed',
    );
    expect(scrubLogText('password="synthetic phrase" token=fake-value')).toBe(
      'password=[redacted] token=[redacted]',
    );
  });
  it('recurses through arrays and errors without modifying caller data', () => {
    const fields = {
      response: [{ authorization: 'synthetic auth', err: new Error(`bad ${canary}`) }],
      exit: 42,
    };
    expect(redact(fields)).toEqual({
      response: [
        { authorization: '[redacted]', err: { name: 'Error', message: 'bad [redacted]' } },
      ],
      exit: 42,
    });
    expect(fields.response[0].authorization).toBe('synthetic auth');
  });
  it('protects BOTH stdout and actual JSONL when callers omit redact()', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      log.error(`provider error ${canary}`, {
        context: {
          password: 'synthetic-nested-password',
          data: [{ err: new Error(`denied ${pat}`) }],
        },
        detail:
          'Authorization: Bearer syntheticAuth credential endpoint https://user:pass@example.test/private?token=fake',
        status: 401,
      });
      const emitted = stdout.mock.calls.map(([s]) => String(s)).join('');
      const disk = readdirSync(state.dir)
        .map((name) => readFileSync(join(state.dir, name), 'utf8'))
        .join('');
      for (const text of [emitted, disk]) {
        expect(text).not.toMatch(
          /SYNTHETIC_ONLY|synthetic-nested-password|syntheticAuth|user:pass|private|token=fake/,
        );
        const record = JSON.parse(text.trim());
        expect(record.status).toBe(401);
        expect(record.msg).toBe('provider error [redacted]');
        expect(text).toContain('example.test');
      }
      expect(emitted).toBe(disk);
    } finally {
      stdout.mockRestore();
    }
  });
  it('keeps useful nonsecret diagnostics and terminates circular/deep inputs', () => {
    expect(redact({ exit: 1, ms: 40, error: 'connection refused', list: ['ok'] })).toEqual({
      exit: 1,
      ms: 40,
      error: 'connection refused',
      list: ['ok'],
    });
    expect(redact({ at: new Date('2026-10-27T12:00:00Z') })).toEqual({
      at: '2026-10-27T12:00:00.000Z',
    });
    const cycle: Record<string, unknown> = { reason: 'retry' };
    cycle.self = cycle;
    expect(redact(cycle)).toEqual({ reason: 'retry', self: '[circular]' });
  });
  it('scrubs message even in serialization fallback and does not throw on getters', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      log.warn(`failure ${canary}`, { value: 1n });
      log.warn(`failure ${canary}`, {
        get value() {
          throw new Error('unserializable');
        },
      });
      expect(stdout.mock.calls).toHaveLength(2);
      for (const [text] of stdout.mock.calls) {
        expect(String(text)).not.toContain(canary);
        expect(JSON.parse(String(text)).note).toBe('fields were not serializable');
      }
    } finally {
      stdout.mockRestore();
    }
  });
});
