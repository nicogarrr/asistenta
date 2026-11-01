import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { fileRetentionDays, pruneStateFiles, retentionIfDue } from '../src/maintenance.js';
import { SessionStore } from '../src/memory/sessions.js';
import { prunable, STATE_ENTRIES } from '../src/state-files.js';

const DAY = 24 * 3_600_000;
const NOW = new Date(2026, 9, 30, 5, 0, 0);

function put(root: string, rel: string, ageDays: number): string {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, 'x');
  const t = (NOW.getTime() - ageDays * DAY) / 1000;
  utimesSync(p, t, t);
  return p;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pa-file-ret-'));
  return {
    root,
    oldLog: put(root, 'log/2026-01-02.jsonl', 100),
    oldUsage: put(root, 'log/usage-2026-01-02.jsonl', 100),
    newLog: put(root, 'log/2026-10-29.jsonl', 1),
    webMetrics: put(root, 'log/web-metrics.jsonl', 100),
    oldShot: put(root, 'screenshots/tv/frame-1.png', 100),
    newShot: put(root, 'screenshots/a.png', 1),
    oldMic: put(root, 'voice/mic-1700000000000.ogg', 100),
    oldOcr: put(root, 'voice/ocr-1700000000000.jpg', 100),
    profiles: put(root, 'voice/speaker-profiles.json', 100),
    oldAudio: put(root, 'media/received/a.ogg', 100),
    otherMedia: put(root, 'media/otro.ogg', 100),
    memoryNote: put(root, 'memory/nota.md', 100),
  };
}

describe('poda de ficheros que crecen (PA_FILE_RETENTION_DAYS)', () => {
  it('apagada por defecto; acepta días enteros positivos', () => {
    expect(fileRetentionDays({})).toBe(0);
    expect(fileRetentionDays({ PA_FILE_RETENTION_DAYS: '0' })).toBe(0);
    expect(fileRetentionDays({ PA_FILE_RETENTION_DAYS: 'abc' })).toBe(0);
    expect(fileRetentionDays({ PA_FILE_RETENTION_DAYS: '-3' })).toBe(0);
    expect(fileRetentionDays({ PA_FILE_RETENTION_DAYS: ' 30.7 ' })).toBe(30);
  });

  it('borra solo lo viejo y solo lo que el registro marca', () => {
    const f = fixture();
    expect(pruneStateFiles(f.root, 30 * DAY, NOW.getTime())).toBe(6);
    for (const gone of [f.oldLog, f.oldUsage, f.oldShot, f.oldMic, f.oldOcr, f.oldAudio])
      expect(existsSync(gone), gone).toBe(false);
    for (const kept of [f.newLog, f.webMetrics, f.newShot, f.profiles, f.otherMedia, f.memoryNote])
      expect(existsSync(kept), kept).toBe(true);
    expect(existsSync(join(f.root, 'screenshots', 'tv'))).toBe(true);
  });

  it('sin directorios de estado no falla', () => {
    expect(pruneStateFiles(join(tmpdir(), 'pa-no-existe-xyz'), DAY, NOW.getTime())).toBe(0);
  });

  it('la pasada diaria la aplica solo con el ajuste puesto', () => {
    const db = new DatabaseSync(':memory:');
    new SessionStore({ db });
    const base = { db, now: NOW, lastRunMs: 0, markRun: () => {} };
    const off = fixture();
    const r0 = retentionIfDue({
      ...base,
      stateDir: off.root,
      // log/ tiene su propio plazo por defecto (PA_LOG_RETENTION_DAYS): aquí se apaga.
      env: { PA_SESSION_RETENTION_DAYS: '0', PA_LOG_RETENTION_DAYS: '0' },
    });
    expect(r0.ran).toBe(false);
    expect(existsSync(off.oldLog)).toBe(true);
    const on = fixture();
    const r1 = retentionIfDue({
      ...base,
      stateDir: on.root,
      env: { PA_SESSION_RETENTION_DAYS: '0', PA_FILE_RETENTION_DAYS: '30' },
    });
    expect(r1).toMatchObject({ ran: true, files: 6 });
    expect(existsSync(on.oldLog)).toBe(false);
  });

  it('toda entrada podable nombra el ajuste y no va en la copia', () => {
    expect(
      prunable()
        .map((p) => p.dir.split('/')[0])
        .sort(),
    ).toEqual([
      'autoupdate',
      'botones',
      'evolve-historial',
      'log',
      'media',
      'screenshots',
      'voice',
    ]);
    for (const e of STATE_ENTRIES.filter((x) => x.prune)) {
      expect(e.backup, e.name).toBe(false);
      expect(e.retention, e.name).toMatch(/PA_FILE_RETENTION_DAYS/);
    }
  });
});
