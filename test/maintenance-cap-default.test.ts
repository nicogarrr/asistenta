import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { retentionIfDue } from '../src/maintenance.js';
import { capped } from '../src/state-files.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ficheros de añadido con tope, con la retención apagada (por defecto)', () => {
  it('el tope de tamaño se aplica igual: el fichero no crece para siempre', () => {
    const root = mkdtempSync(join(tmpdir(), 'pa-cap-default-'));
    dirs.push(root);
    const [first] = capped();
    expect(first).toBeDefined();
    const { file, maxBytes } = first as { file: string; maxBytes: number };
    const path = join(root, file);
    mkdirSync(join(path, '..'), { recursive: true });
    const line = `${JSON.stringify({ op: 'search', ms: 120, pad: 'x'.repeat(200) })}\n`;
    writeFileSync(path, line.repeat(Math.ceil((maxBytes * 1.5) / line.length)));
    expect(statSync(path).size).toBeGreaterThan(maxBytes);

    const db = new DatabaseSync(':memory:');
    retentionIfDue({
      db,
      now: new Date('2026-10-30T12:00:00Z'),
      lastRunMs: 0,
      markRun: () => {},
      stateDir: root,
      env: { PA_SESSION_RETENTION_DAYS: '0' },
    });
    expect(statSync(path).size).toBeLessThanOrEqual(maxBytes);
  });
});
