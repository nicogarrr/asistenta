import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'linux')(
  'hidden TTY restores modes on success, editing, paste, CtrlC, EOF and signals',
  () => {
    const result = spawnSync(
      'python3',
      [
        resolve('test/fixtures/setup-terminal-pty.py'),
        process.execPath,
        pathToFileURL(resolve('dist/setup-terminal.js')).href,
      ],
      { encoding: 'utf8', timeout: 25000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const scenarios = JSON.parse(result.stdout);
    expect(scenarios).toHaveLength(17);
    expect(
      scenarios.every(
        (x: { no_echo: boolean; modes_restored: boolean; expected_result: boolean }) =>
          x.no_echo && x.modes_restored && x.expected_result,
      ),
    ).toBe(true);
  },
);
