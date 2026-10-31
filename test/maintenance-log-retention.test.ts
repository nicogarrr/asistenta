import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { retentionIfDue } from '../src/maintenance.js';

const DAY = 24 * 3_600_000;
const NOW = new Date('2026-10-30T05:00:00+01:00');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function stateWith(files: Record<string, number>): string {
  const root = mkdtempSync(join(tmpdir(), 'pa-log-ret-'));
  dirs.push(root);
  const log = join(root, 'log');
  mkdirSync(log, { recursive: true });
  for (const [name, ageDays] of Object.entries(files)) {
    const p = join(log, name);
    writeFileSync(p, '{}\n');
    const t = (NOW.getTime() - ageDays * DAY) / 1000;
    utimesSync(p, t, t);
  }
  return root;
}

const run = (root: string, env: NodeJS.ProcessEnv = {}) =>
  retentionIfDue({
    db: new DatabaseSync(':memory:'),
    now: NOW,
    lastRunMs: 0,
    markRun: () => {},
    stateDir: root,
    env: { PA_SESSION_RETENTION_DAYS: '0', ...env },
  });

describe('log/ no crece para siempre con la configuración por defecto', () => {
  it('borra los diarios de más de 30 días y los de consumo de más de 400', () => {
    const root = stateWith({
      '2026-01-01.jsonl': 300,
      '2026-10-20.jsonl': 10,
      'usage-2026-01-01.jsonl': 300,
      'usage-2025-01-01.jsonl': 500,
      'web-metrics.jsonl': 500,
      'otro.txt': 500,
    });
    run(root);
    expect(readdirSync(join(root, 'log')).sort()).toEqual([
      '2026-10-20.jsonl',
      'otro.txt',
      'usage-2026-01-01.jsonl',
      'web-metrics.jsonl',
    ]);
  });

  it('PA_LOG_RETENTION_DAYS=0 no borra nada', () => {
    const root = stateWith({ '2026-01-01.jsonl': 300, 'usage-2025-01-01.jsonl': 500 });
    run(root, { PA_LOG_RETENTION_DAYS: '0' });
    expect(readdirSync(join(root, 'log'))).toHaveLength(2);
  });

  it('PA_LOG_RETENTION_DAYS=7 acorta los diarios pero no el consumo', () => {
    const root = stateWith({ '2026-10-20.jsonl': 10, 'usage-2026-10-20.jsonl': 10 });
    run(root, { PA_LOG_RETENTION_DAYS: '7' });
    expect(readdirSync(join(root, 'log'))).toEqual(['usage-2026-10-20.jsonl']);
  });
});
