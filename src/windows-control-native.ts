/** Native DACL checks and a kernel file lock held until the Node owner's stdin closes. */
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = String.raw`
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -Force
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
function CheckPath([string]$p,[bool]$directory) {
 $cursor=[IO.Path]::GetFullPath($p)
 while($cursor) {
  $item=Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
  if($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse'}
  $next=Split-Path -Parent $cursor
  if($next -eq $cursor){break};$cursor=$next
 }
 $item=Get-Item -LiteralPath $p -Force
 if([bool]$item.PSIsContainer -ne $directory){throw 'type'}
 $acl=Get-Acl -LiteralPath $p
 if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'owner'}
 foreach($r in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin @($sid.Value,'S-1-5-18','S-1-5-32-544') -and ($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0){throw 'shared'}
 }
}
function PrivateDir([string]$p) {
 if(Test-Path -LiteralPath $p){CheckPath $p $true;return}
 $parent=Split-Path -Parent $p
 if(-not(Test-Path -LiteralPath $parent)){throw 'parent missing'}
 $cursor=$parent
 while($cursor){$item=Get-Item -LiteralPath $cursor -Force;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse'};$next=Split-Path -Parent $cursor;if($next -eq $cursor){break};$cursor=$next}
 $acl=New-Object Security.AccessControl.DirectorySecurity
 $acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
 (New-Object IO.DirectoryInfo($p)).Create($acl)
 CheckPath $p $true
}
try {
 $state=$env:PA_CONTROL_STATE
 if($env:PA_CONTROL_MODE -eq 'init'){PrivateDir $state;PrivateDir (Join-Path $state 'control-win');exit 0}
 CheckPath $state $true
 $dir=Join-Path $state 'control-win';CheckPath $dir $true
 if($env:PA_CONTROL_MODE -eq 'check') {
  if($env:PA_CONTROL_LEAF){$leaf=Join-Path $dir $env:PA_CONTROL_LEAF;if(-not(Test-Path -LiteralPath $leaf)){exit 4};CheckPath $leaf $false};exit 0
 }
 $lock=Join-Path $dir 'owner.lock'
 if($env:PA_CONTROL_MODE -eq 'hold' -and (Test-Path -LiteralPath $lock)){CheckPath $lock $false}
 try{$handle=[IO.File]::Open($lock,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}catch [IO.IOException]{[Console]::Out.WriteLine('BUSY');exit 3}
 if($env:PA_CONTROL_MODE -in @('probe','confirm')){if($env:PA_CONTROL_MODE -eq 'confirm' -and (Test-Path -LiteralPath (Join-Path $dir 'ready.json'))){$handle.Dispose();throw 'another ready'};$handle.Dispose();CheckPath $lock $false;[Console]::Out.WriteLine('FREE');exit 0}
 [Console]::Out.WriteLine('LOCKED');[Console]::Out.Flush()
 while($null -ne [Console]::In.ReadLine()){}
 $handle.Dispose();exit 0
} catch { [Console]::Error.WriteLine('DACL, propietario, reparse point o control nativo no verificables.');exit 1 }
`;
function options(state: string, mode: string, leaf = '') {
  if (process.platform !== 'win32') throw new Error('Control DACL requiere Windows nativo.');
  return {
    encoding: 'utf8' as const,
    windowsHide: true,
    timeout: 10_000,
    env: { ...process.env, PA_CONTROL_STATE: state, PA_CONTROL_MODE: mode, PA_CONTROL_LEAF: leaf },
  };
}
const args = () => [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand',
  Buffer.from(SCRIPT, 'utf16le').toString('base64'),
];
const executable = () =>
  join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
export function windowsNative(
  state: string,
  mode: 'init' | 'check' | 'probe' | 'confirm',
  leaf = '',
): 'free' | 'busy' {
  if (leaf && !/^(ready\.json|request\.json|[a-f0-9]{64}\.stopped)$/.test(leaf))
    throw new Error('Archivo de control inválido.');
  const result = spawnSync(executable(), args(), options(state, mode, leaf));
  if (
    (mode === 'probe' || mode === 'confirm') &&
    result.status === 3 &&
    result.stdout.trim() === 'BUSY'
  )
    return 'busy';
  if (result.status === 4) throw Object.assign(new Error('Metadata ausente.'), { code: 'ENOENT' });
  if (result.error || result.status !== 0)
    throw new Error(
      'DACL, propietario o control nativo no verificables; no se ha detenido ningún proceso.',
    );
  return 'free';
}
export async function windowsOwnership(
  state: string,
): Promise<{ release(): Promise<void>; alive(): boolean }> {
  const child = spawn(executable(), args(), {
    ...options(state, 'hold'),
    timeout: undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let expected = false;
  let live = true;
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => {
      live = false;
      resolve();
    }),
  );
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      child.stdin.end();
      reject(new Error('Control nativo sin respuesta.'));
    }, 12_000);
    const fail = () => {
      clearTimeout(timer);
      reject(new Error('Control ocupado o DACL no verificable.'));
    };
    child.once('error', fail);
    child.once('exit', fail);
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (output.trim() !== 'LOCKED') return;
      clearTimeout(timer);
      child.removeListener('error', fail);
      child.removeListener('exit', fail);
      // Losing ownership must not leave a daemon running beside a replacement.
      child.once('exit', () => {
        if (!expected) process.exit(1);
      });
      resolve();
    });
  });
  return {
    alive: () => live,
    async release() {
      expected = true;
      child.stdin.end();
      await exited;
    },
  };
}
