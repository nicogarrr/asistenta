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

describe.skipIf(process.platform !== 'win32')('privacidad nativa de logs', () => {
  it('rechaza ACL compartida y junction antes de escribir fuera del estado', () => {
    const root = mkdtempSync(join(tmpdir(), 'pa-log-acl-'));
    const helper = resolve('deploy/windows/private-logs.ps1').replaceAll("'", "''");
    const literal = root.replaceAll("'", "''");
    const scriptText = `
$ErrorActionPreference='Stop'
. '${helper}'
$root='${literal}'
$state=Join-Path $root 'private'
New-PrivateDirectory $state
$outside=Join-Path $root 'outside'
New-Item -ItemType Directory -Path $outside|Out-Null
$log=Join-Path $state 'log'
New-Item -ItemType Junction -Path $log -Target $outside|Out-Null
$rejected=$false
try{Assert-PrivateLogTargets $state}catch{$rejected=$true}
if(-not $rejected){throw 'junction aceptada'}
if((Get-ChildItem -LiteralPath $outside).Count){throw 'escritura fuera del estado'}
[IO.Directory]::Delete($log)
New-PrivateDirectory $log
$acl=Get-Acl -LiteralPath $state
$everyone=New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($everyone,'Read','ContainerInherit,ObjectInherit','None','Allow')))
Set-Acl -LiteralPath $state -AclObject $acl
$rejected=$false
try{Assert-PrivateLogTargets $state}catch{$rejected=$true}
if(-not $rejected){throw 'ACL compartida aceptada'}
if((Get-ChildItem -LiteralPath $log).Count){throw 'logs escritos antes de validar ACL'}
`;
    try {
      const child = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', scriptText],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true },
      );
      expect(child.status, child.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

it('instalador valida antes de reemplazar y restaura XML si el registro falla', () => {
  const source = readFileSync('deploy/windows/install-autostart.ps1', 'utf8');
  expect(source.indexOf("throw 'Falta private-logs.ps1.'")).toBeLessThan(
    source.indexOf('$previousXml ='),
  );
  expect(source).toContain('Export-ScheduledTask');
  expect(source).toContain('-Xml $previousXml -Force');
  const install = source.slice(source.indexOf('function Install {'));
  expect(install).not.toContain('Unregister-ScheduledTask');
  expect(install).toContain("'resolve-state.mjs'");
  const resolver=readFileSync('deploy/windows/resolve-state.mjs','utf8');
  expect(resolver).toContain('process.loadEnvFile()');
  expect(resolver).toContain('process.env.PA_STATE_DIR || join(homedir()');
});

describe.skipIf(process.platform !== 'win32')(
  'instalador con cmdlets falsos, sin tareas reales',
  () => {
    it('usa .env salvo ambiente y restaura la tarea anterior tras registro fallido', () => {
      const root = mkdtempSync(join(tmpdir(), 'pa-task-mock-'));
      const repo = join(root, 'repo');
      mkdirSync(join(repo, 'dist'), { recursive: true });
      mkdirSync(join(repo, 'deploy', 'windows'), { recursive: true });
      writeFileSync(join(repo, 'dist', 'cli.js'), '');
      for (const name of ['run-hidden.ps1', 'private-logs.ps1'])
        writeFileSync(join(repo, 'deploy', 'windows', name), '# synthetic');
      const fromEnvfile = join(root, 'from-dotenv');
      writeFileSync(join(repo, '.env'), `PA_STATE_DIR="${fromEnvfile.replaceAll('\\', '/')}"\n`);
      const quote = (s: string) => s.replaceAll("'", "''");
      const installer = quote(resolve('deploy/windows/install-autostart.ps1'));
      try {
        for (const ambient of [false, true]) {
          const calls = join(root, ambient ? 'ambient.txt' : 'dotenv.txt');
          const scriptText = `
$ErrorActionPreference='Stop'
${ambient ? `$env:PA_STATE_DIR='${quote(join(root, 'ambient'))}'` : 'Remove-Item Env:PA_STATE_DIR -ErrorAction SilentlyContinue'}
function Get-ScheduledTask { return [pscustomobject]@{State='Running'} }
function Export-ScheduledTask { return '<previous-task/>' }
function Unregister-ScheduledTask { throw 'NO se debe borrar la tarea anterior' }
function Stop-ScheduledTask { throw 'NO se debe parar la tarea anterior antes de validar' }
function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory); [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String(($Argument -split ' ')[-1]))|Set-Content -LiteralPath '${quote(calls)}';return @{} }
function New-ScheduledTaskTrigger { return @{} }
function New-ScheduledTaskSettingsSet { return @{} }
function New-ScheduledTaskPrincipal { return @{} }
function New-Object { param($ComObject)
 if($ComObject -ne 'Schedule.Service'){throw 'COM no esperado'}
 $folder=[pscustomobject]@{}
 $folder|Add-Member ScriptMethod GetFolder {param($p) return $this}
 $service=[pscustomobject]@{Folder=$folder}
 $service|Add-Member ScriptMethod Connect {}
 $service|Add-Member ScriptMethod GetFolder {param($p) return $this.Folder}
 return $service
}
function Register-ScheduledTask { param($TaskName,$TaskPath,$Action,$Trigger,$Settings,$Principal,$Description,[switch]$Force,$Xml,$ErrorAction)
 if($Xml -eq '<previous-task/>'){Add-Content -LiteralPath '${quote(calls)}' -Value 'RESTORED';return @{}}
 throw 'synthetic register failure'
}
. '${installer}' -Force -RepoDir '${quote(repo)}' -NodeExe '${quote(process.execPath)}'
`;
          const child = spawnSync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', scriptText],
            { encoding: 'utf8', timeout: 30_000, windowsHide: true },
          );
          expect(child.status, child.stderr).toBe(1);
          const evidence = readFileSync(calls, 'utf8');
          expect(evidence).toContain(ambient ? join(root, 'ambient') : fromEnvfile);
          expect(evidence).toContain('RESTORED');
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  },
);
