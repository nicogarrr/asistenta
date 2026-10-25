import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve('deploy/windows');
it('install entrypoint is explicit and does not silently install in serve', () => {
  const install = readFileSync(join(root, 'install-all.ps1'), 'utf8');
  expect(install).toContain('SupportsShouldProcess=$true');
  expect(install).toContain('[switch]$DisableLocalLlm');
  expect(install).not.toContain('Stop-ScheduledTask');
  const launcher = readFileSync(join(root, 'run-hidden.ps1'), 'utf8');
  expect(launcher).toContain("try{& $notify 'supervisor'}catch{}");
  expect(launcher).toContain('}else{$process.Kill();$process.WaitForExit()}');
  expect(install).toContain('Invoke-BoundedProgram');
  const core = readFileSync(join(root, 'autostart-core.ps1'), 'utf8').replace(/^\s*#.*$/gm, '');
  expect(core).not.toMatch(/Stop-Process|process\.kill|Read-Pid|agent\.pid/);
  expect(core).not.toContain('docker rm');
});
describe.skipIf(process.platform !== 'win32')(
  'native Windows autoarranque without live task writes',
  () => {
    const ps = join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    it('real PS5 parser and mocked Scheduler: idempotence, spaces, limits, exact child stop', () => {
      const p = spawnSync(
        ps,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(root, 'test-autostart-canaries.ps1'),
        ],
        { encoding: 'utf8', timeout: 30000, windowsHide: true },
      );
      expect(p.stderr).toBe('');
      expect(p.stdout).toContain('autostart canaries OK');
      expect(p.status).toBe(0);
    });
    it('real owned launcher lock rejects a second instance without launching its child', async () => {
      const tmp = mkdtempSync(join(tmpdir(), "pa supervisor's space "));
      const repo = join(tmp, 'repo');
      const state = join(tmp, 'state');
      mkdirSync(join(repo, 'dist'), { recursive: true });
      writeFileSync(
        join(repo, 'dist', 'cli.js'),
        `
const fs=require('fs');const path=require('path');
fs.appendFileSync(path.join(process.env.PA_STATE_DIR,'starts.txt'),'one\\n');
setTimeout(()=>process.exit(0),5000);`,
      );
      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(root, 'run-hidden.ps1'),
        '-RepoDir',
        repo,
        '-NodeExe',
        process.execPath,
        '-StateDir',
        state,
      ];
      const env = { ...process.env, PA_AUTOSTART_SUPERVISE: '1' };
      const first = spawn(ps, args, { env, windowsHide: true, stdio: 'ignore' });
      const done = new Promise<number | null>((resolve) => first.on('close', resolve));
      try {
        const until = Date.now() + 15000;
        while (!existsSync(join(state, 'starts.txt')) && Date.now() < until)
          await new Promise((r) => setTimeout(r, 50));
        expect(existsSync(join(state, 'starts.txt'))).toBe(true);
        const second = spawnSync(ps, args, {
          env,
          windowsHide: true,
          encoding: 'utf8',
          timeout: 15000,
        });
        expect(second.status).toBe(1);
        expect(await done).toBe(0);
        expect(readFileSync(join(state, 'starts.txt'), 'utf8')).toBe('one\n');
      } finally {
        if (first.exitCode === null) first.kill();
        rmSync(tmp, { recursive: true, force: true });
      }
    }, 30000);
    // El instalador exige Node >= 24 (engines del repo): con un runtime anterior
    // se niega con razón, así que este caso no mide el autoarranque sino el Node
    // del runner. En CI (Node 24) se ejecuta.
    it.skipIf(Number(process.versions.node.split('.')[0]) < 24)(
      'WhatIf on real installer leaves no state/config/tasks; space and apostrophe paths',
      () => {
        const tmp = mkdtempSync(join(tmpdir(), "pa installer's space & "));
        try {
          const repo = join(tmp, 'repo');
          const state = join(tmp, 'uncreated state');
          for (const d of ['dist', 'deploy/windows', 'deploy/browserd', 'browserd/.venv/Scripts'])
            mkdirSync(join(repo, d), { recursive: true });
          for (const f of [
            'dist/cli.js',
            'deploy/browserd/start-browserd-hidden.vbs',
            'browserd/.venv/Scripts/python.exe',
          ])
            writeFileSync(join(repo, f), 'synthetic prerequisite');
          for (const f of [
            'install-all.ps1',
            'autostart-core.ps1',
            'run-stack.ps1',
            'run-hidden.ps1',
          ])
            copyFileSync(join(root, f), join(repo, 'deploy/windows', f));
          const p = spawnSync(
            ps,
            [
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              join(repo, 'deploy/windows/install-all.ps1'),
              '-RepoDir',
              repo,
              '-NodeExe',
              process.execPath,
              '-StateDir',
              state,
              '-Start',
              '-WhatIf',
            ],
            { encoding: 'utf8', timeout: 30000, windowsHide: true },
          );
          expect(p.status, `${p.stdout}\n${p.stderr}`).toBe(0);
          expect(p.stdout).toMatch(/What if|WhatIf/i);
          expect(() => readFileSync(join(state, 'log', 'supervisor-restarts.json'))).toThrow();
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      },
    );
  },
);
