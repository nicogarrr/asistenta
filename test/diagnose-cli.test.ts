import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { diagnoseCommand } from '../src/diagnose-cli.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-diagnose-cli-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pa diagnose', () => {
  it('prints Spanish evidence from an empty state without creating anything', async () => {
    const missing = join(dir, 'not-created');
    let out = '';
    expect(
      await diagnoseCommand([], { stateDir: missing }, (s) => {
        out += s;
      }),
    ).toBe(0);
    expect(out).toContain('no hay fichero de pid legible');
    expect(out).toContain('no existe, Asistenta no está dando señales de vida');
    expect(out).not.toMatch(/\bdaemon\b/);
    expect(existsSync(missing)).toBe(false);
  });

  it('reads approvals without changing database bytes or adding files', async () => {
    const file = join(dir, 'approvals.db');
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE approval_scopes (level TEXT, tool TEXT)');
    db.exec("INSERT INTO approval_scopes VALUES ('always', 'shell')");
    db.close();
    const before = readFileSync(file);
    let out = '';
    expect(
      await diagnoseCommand(['--json'], { stateDir: dir }, (s) => {
        out += s;
      }),
    ).toBe(0);
    const report = JSON.parse(out);
    expect(report.approvals.always).toEqual(['shell']);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(['approvals.db']);
  });

  it('rejects unknown or repeated options without reading state', async () => {
    for (const args of [['--restart'], ['--json', '--json'], ['elsewhere']]) {
      let out = '';
      let err = '';
      expect(
        await diagnoseCommand(
          args,
          { stateDir: dir },
          (s) => {
            out += s;
          },
          (s) => {
            err += s;
          },
        ),
      ).toBe(2);
      expect(out).toBe('');
      expect(err).toBe('uso: pa diagnose [--json]\n');
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it('does not alter an unreadable pid file', async () => {
    writeFileSync(join(dir, 'agent.pid'), 'not-a-pid');
    let out = '';
    expect(
      await diagnoseCommand(['--json'], { stateDir: dir }, (s) => {
        out += s;
      }),
    ).toBe(0);
    expect(JSON.parse(out).state.pid).toBe(null);
    expect(readFileSync(join(dir, 'agent.pid'), 'utf8')).toBe('not-a-pid');
  });
});
