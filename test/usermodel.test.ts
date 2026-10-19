/**
 * Self-enriching user model: repeated nudges autosave once; the profile is
 * visible and deletable (snapshot.removeEntries).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemorySnapshot } from '../src/memory/snapshot.js';
import { AUTOSAVE_DAYS, NudgeTracker, trackerKey } from '../src/memory/usermodel.js';

vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usermodel-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SUGGESTION = 'Eso suena a algo duradero: "prefiero los resumenes cortos". ¿Lo guardo?';

describe('NudgeTracker', () => {
  it('autosaves on the third distinct day, exactly once, across restarts', () => {
    const t = new NudgeTracker(dir);
    expect(t.record(SUGGESTION, '2026-10-17')).toBe(false);
    expect(t.record(SUGGESTION, '2026-10-17')).toBe(false); // mismo día no cuenta dos veces
    expect(t.record(SUGGESTION, '2026-10-18')).toBe(false);
    expect(t.daysFor(SUGGESTION)).toBe(2);
    expect(t.record(SUGGESTION, '2026-10-19')).toBe(true);
    expect(t.record(SUGGESTION, '2026-10-20')).toBe(false); // ya autoguardada
    expect(AUTOSAVE_DAYS).toBe(3);

    // Un tracker nuevo sobre el mismo dir recuerda el autoguardado.
    const t2 = new NudgeTracker(dir);
    expect(t2.record(SUGGESTION, '2026-10-21')).toBe(false);
  });

  it('folds accents and case into the same key', () => {
    expect(trackerKey('Prefiero Café')).toBe(trackerKey('prefiero cafe'));
  });

  it('survives a corrupt state file', () => {
    const bad = mkdtempSync(join(tmpdir(), 'usermodel-bad-'));
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(join(bad, 'nudge-tracker.json'), '{not json');
    const t = new NudgeTracker(bad);
    expect(t.record(SUGGESTION, '2026-10-19')).toBe(false);
    rmSync(bad, { recursive: true, force: true });
  });
});

describe('snapshot.removeEntries', () => {
  it('removes matching entries case/accent-insensitively and persists', () => {
    const snap = new MemorySnapshot({ dir });
    snap.appendEntry('Le gusta el café solo');
    snap.appendEntry('Trabaja en remoto los lunes');
    expect(snap.removeEntries('CAFE')).toBe(1);
    expect(snap.load()).not.toContain('café');
    expect(snap.load()).toContain('remoto');

    const snap2 = new MemorySnapshot({ dir });
    expect(snap2.load()).toContain('remoto');
    expect(snap2.removeEntries('café')).toBe(0);
    expect(snap2.removeEntries('')).toBe(0);
  });
});
