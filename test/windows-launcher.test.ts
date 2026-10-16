import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve('deploy/windows/run-hidden.ps1');
it('task stays limited, interactive-user, waits for exit and never routes through cmd/winpty', () => {
  const install = readFileSync('deploy/windows/install-autostart.ps1', 'utf8');
  const launcher = readFileSync(script, 'utf8');
  for (const contract of [
    '-AtLogOn -User $UserId',
    '-LogonType Interactive -RunLevel Limited',
    '-RestartCount 999',
    '-MultipleInstances IgnoreNew',
    '-WindowStyle Hidden',
    '-EncodedCommand',
    "'run-hidden.ps1'",
  ]) {
    if (contract === "'run-hidden.ps1'")
      expect(install).toContain('deploy\\windows\\run-hidden.ps1');
    else expect(install).toContain(contract);
  }
  for (const contract of [
    '$info.RedirectStandardInput = $true',
    '$process.StandardInput.Close()',
    '$process.WaitForExit()',
    '$exitCode = $process.ExitCode',
    'exit $exitCode',
    '$info.UseShellExecute = $false',
    '$info.CreateNoWindow = $true',
  ])
    expect(launcher).toContain(contract);
  expect(launcher).not.toMatch(/Invoke-Expression|Start-Process|cmd\.exe|winpty/);
});

describe.skipIf(process.platform !== 'win32')(
  'PowerShell launcher nativo sin TTY ni secretos reales',
  () => {
    function run(exit: number) {
      const root = mkdtempSync(join(tmpdir(), "pa launcher's space "));
      const repo = join(root, 'repo & prueba');
      const state = join(root, 'state');
      mkdirSync(join(repo, 'dist'), { recursive: true });
      writeFileSync(
        join(repo, 'dist', 'cli.js'),
        `
const fs=require('fs');
if(process.stdin.isTTY)process.exit(98);
if(process.argv[2]!=='serve')process.exit(97);
console.log('synthetic stdout'); console.error('synthetic stderr');
process.stdin.on('end',()=>{fs.writeFileSync(require('path').join(process.env.PA_STATE_DIR,'eof.txt'),'closed');process.exit(${exit})});process.stdin.resume();`,
      );
      try {
        const child = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            script,
            '-RepoDir',
            repo,
            '-NodeExe',
            process.execPath,
            '-StateDir',
            state,
          ],
          { encoding: 'utf8', timeout: 30_000, input: '', windowsHide: true },
        );
        expect(child.error).toBeUndefined();
        expect(child.status, child.stderr).toBe(exit);
        expect(readFileSync(join(state, 'eof.txt'), 'utf8')).toBe('closed');
        expect(readFileSync(join(state, 'log', 'launcher.stdout.log'), 'utf8')).toContain(
          'synthetic stdout',
        );
        const stderr = readFileSync(join(state, 'log', 'launcher.stderr.log'), 'utf8');
        expect(stderr).toContain('synthetic stderr');
        expect(stderr).toContain(`exit=${exit}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
    it('preserva exit 0 y stdin cerrado con rutas con espacios, apostrofe y ampersand', () =>
      run(0));
    it('preserva exit no cero y captura la causa de fallo para el supervisor', () => run(17));
    it('parsea ambos scripts con el parser nativo sin registrar una tarea', () => {
      for (const file of [script, resolve('deploy/windows/install-autostart.ps1')]) {
        const literal = file.replaceAll("'", "''");
        const child = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('${literal}',[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|Out-String|Write-Error;exit 1}`,
          ],
          { encoding: 'utf8', timeout: 15_000, windowsHide: true },
        );
        expect(child.status, child.stderr).toBe(0);
      }
    });
  },
);
