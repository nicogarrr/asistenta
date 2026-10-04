import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Archive, isoWeek } from '../src/evolve/archive.js';
import { parseChecks, parseSuite } from '../src/evolve/measure.js';
import {
  comparable,
  judge,
  type Measurement,
  scoreOf,
  touchesForbidden,
} from '../src/evolve/score.js';

/**
 * The self-improvement loop, tested on the part that decides.
 *
 * These are pure functions on purpose. The loop moves the agent's own source around, and
 * the one question that matters every week is "did this get better or did the number move",
 * so that question is isolated here where it can be wrong loudly and cheaply.
 */

const run = (over: Partial<Measurement> = {}): Measurement => ({
  passed: 100,
  failed: 0,
  checks: 10,
  checksFailed: 0,
  durationMs: 60_000,
  ...over,
});

describe('score', () => {
  it('a broken end-to-end check costs more than a failed unit test', () => {
    // Both penalties are measured against the same healthy baseline, because comparing
    // two different baselines would compare their totals instead of the penalties.
    const healthy = scoreOf(run({ passed: 100, failed: 0, checks: 10, checksFailed: 0 }));
    const lostTest = scoreOf(run({ passed: 100, failed: 1, checks: 10, checksFailed: 0 }));
    const lostCheck = scoreOf(run({ passed: 100, failed: 0, checks: 10, checksFailed: 1 }));
    // The check has to hurt more, because the suite can be green while the thing the user
    // asked for is broken.
    expect(healthy - lostCheck).toBeGreaterThan(healthy - lostTest);
    expect(healthy - lostCheck).toBeGreaterThan(0);
  });
});

describe('comparability', () => {
  it('refuses a run that errored, because it has no score', () => {
    expect(comparable(run(), run({ error: 'la suite no arrancó' }))).toBe(false);
  });

  it('refuses a run so slow the machine, not the code, was measured', () => {
    expect(comparable(run(), run({ durationMs: 60 * 60_000 }))).toBe(false);
  });

  it('refuses a run that silently did nothing', () => {
    // Zero tests and zero checks reads as a catastrophic score if taken at face value.
    expect(comparable(run(), run({ passed: 0, checks: 0 }))).toBe(false);
  });

  it('accepts two ordinary runs', () => {
    expect(comparable(run(), run({ passed: 101 }))).toBe(true);
  });
});

describe('judge', () => {
  it('promotes a clear improvement', () => {
    const v = judge(run(), run({ passed: 130, checks: 14 }));
    expect(v.kind).toBe('promote');
    expect(v.delta).toBeGreaterThan(0);
  });

  it('asks for another attempt when the gain is real but below the bar', () => {
    // +1 check is +2 points on a base of ~120: measurable, but under 1%.
    const v = judge(run(), run({ checks: 11 }), { minGainPct: 5 });
    expect(v.kind).toBe('retry');
  });

  it('discards instead of blocking the loop when nothing improved', () => {
    const v = judge(run(), run());
    expect(v.kind).toBe('discard');
  });

  it('refuses a candidate that regressed, even if the headline score rose', () => {
    // More passing tests AND one broken end-to-end flow: exactly the trade this project
    // keeps hitting, and the one the loop must never make.
    const v = judge(run(), run({ passed: 140, checksFailed: 1 }));
    expect(v.kind).toBe('discard');
    expect(v.reason).toMatch(/Rompió algo|regresión/i);
  });

  it('discards an unmeasurable candidate rather than calling it neutral', () => {
    const v = judge(run(), run({ error: 'timeout' }));
    expect(v.kind).toBe('discard');
    expect(v.reason).toMatch(/falló|comparables/);
  });
});

describe('forbidden files', () => {
  it('refuses edits to the gate, the money path and the vault', () => {
    const touched = touchesForbidden([
      'src/core/prompt.ts',
      'src/permissions.ts',
      'src/vault.ts',
      'src/tools/checkout.ts',
    ]);
    expect(touched).toEqual(
      expect.arrayContaining(['src/permissions.ts', 'src/vault.ts', 'src/tools/checkout.ts']),
    );
  });

  it('allows the files the loop is supposed to improve', () => {
    expect(touchesForbidden(['src/core/prompt.ts', 'src/tools/browser.ts'])).toEqual([]);
  });
});

describe('archive', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pa-evolve-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps every attempt, including the discarded ones', () => {
    const a = new Archive(join(dir, 'attempts.jsonl'));
    a.add({ week: '2026-W15', kind: 'hypothesis', hypothesis: 'arreglar el snapshot' });
    a.add({
      week: '2026-W15',
      kind: 'verdict',
      hypothesis: 'arreglar el snapshot',
      verdict: 'retry',
    });
    a.add({ week: '2026-W15', kind: 'verdict', hypothesis: 'otra idea', verdict: 'discard' });
    expect(a.read()).toHaveLength(3);
    // A dead end is the most valuable record in the file: it stops next week retrying it.
    expect(a.deadEnds('2026-W15')).toEqual(['otra idea']);
  });

  it('survives a half-written last line from a killed process', () => {
    const path = join(dir, 'attempts.jsonl');
    const a = new Archive(path);
    a.add({ week: '2026-W15', kind: 'hypothesis', hypothesis: 'idea buena' });
    writeFileSync(path, `${JSON.stringify(a.read()[0])}\n{"id":2,"kind":"patr`, 'utf8');
    expect(a.read()).toHaveLength(1);
  });

  it('names the ISO week, which is the unit the loop runs on', () => {
    expect(isoWeek(new Date('2026-01-01T12:00:00Z'))).toMatch(/^2026-W\d{2}$/);
  });
});

describe('measurement parsing', () => {
  it('reads the vitest summary', () => {
    expect(parseSuite(' Tests  64 passed (64)\n')).toEqual({ passed: 64, failed: 0 });
    expect(parseSuite(' Tests  3 passed | 1 failed (4)')).toEqual({ passed: 3, failed: 1 });
  });

  it('reads the offline probes', () => {
    expect(parseChecks('PASA  uno\nPASA  dos\nFALLA  tres\n')).toEqual({ passed: 2, failed: 1 });
  });
});
