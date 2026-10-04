import { describe, expect, it } from 'vitest';
import { formatDuration, formatStatus, summarizeLog } from '../src/status.js';

describe('summarizeLog', () => {
  it('counts levels, dedupes errors, skips broken lines and ignores fields', () => {
    const log = [
      JSON.stringify({ level: 'info', msg: 'ok' }),
      JSON.stringify({ level: 'warn', msg: 'w' }),
      JSON.stringify({ level: 'error', msg: 'a', token: 'SECRET' }),
      '{broken',
      JSON.stringify({ level: 'error', msg: 'b' }),
      JSON.stringify({ level: 'error', msg: 'a' }),
      '',
    ].join('\n');
    const s = summarizeLog(log);
    expect(s).toEqual({ warns: 1, errors: 3, recentErrors: ['a', 'b'] });
    expect(JSON.stringify(s)).not.toContain('SECRET');
  });
  it('caps recent errors', () => {
    const log = [1, 2, 3, 4, 5]
      .map((i) => JSON.stringify({ level: 'error', msg: `e${i}` }))
      .join('\n');
    expect(summarizeLog(log).recentErrors).toEqual(['e5', 'e4', 'e3']);
  });
});

describe('formatStatus', () => {
  it('formats durations', () => {
    expect(formatDuration(10_000)).toBe('menos de 1 min');
    expect(formatDuration(95 * 60_000)).toBe('1 h 35 min');
    expect(formatDuration(50 * 3_600_000)).toBe('2 d 2 h');
  });
  it('is honest about missing tools and unreadable log', () => {
    const text = formatStatus({
      version: '0.1.0',
      node: 'v24',
      uptimeMs: 3_600_000,
      tools: [
        { name: 'yt-dlp', ok: true },
        { name: 'curl-impersonate', ok: false, note: 'sin él, algunos PDF fallan' },
      ],
      log: null,
      pageWatches: 2,
    });
    expect(text).toContain('OK yt-dlp');
    expect(text).toContain('FALTA curl-impersonate - sin él');
    expect(text).toContain('no he podido leerlo');
    expect(text).toContain('vigiladas: 2');
  });
});
