import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
    expect(out).toContain('no existe, el daemon no está escribiendo');
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

  it('routes the built CLI without provider keys or Telegram token', () => {
    const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'diagnose', '--json'], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PA_STATE_DIR: dir,
        PA_DESKTOP: 'off',
        PA_PROVIDER_API_KEY: '',
        TELEGRAM_BOT_TOKEN: '',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.state.pid).toBe(null);
    expect(report.actions.file).toBe(join(dir, 'actions.jsonl'));
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
