import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, it as baseIt, expect } from 'vitest';
import { windowsNative } from '../src/windows-control-native.js';
import { openWindowsDaemonControl, stopWindowsDaemon } from '../src/windows-daemon-control.js';

const it = process.platform === 'win32' ? baseIt : baseIt.skip;
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill();
      await new Promise((done) => c.once('exit', done));
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function state() {
  const root = mkdtempSync(join(tmpdir(), 'pa-win-control-'));
  roots.push(root);
  return join(root, 'private-state');
}
async function fixture(dir: string, fail = false) {
  const wrapper = pathToFileURL(resolve('dist/controlled-daemon.js')).href;
  const lifecycle = pathToFileURL(resolve('dist/lifecycle.js')).href;
  const code = `import {controlledDaemon} from ${JSON.stringify(wrapper)};import {installLifecycle} from ${JSON.stringify(lifecycle)};import {writeFileSync} from 'node:fs';await controlledDaemon(async ctl=>{const life=installLifecycle({name:'agent',shutdownBudgetMs:10000,onShutdown:async()=>{await new Promise(r=>setTimeout(r,150));${fail ? "throw new Error('synthetic drainer failed');" : `writeFileSync(${JSON.stringify(join(dir, 'drained'))},'yes');`}}});ctl.attach(life);ctl.ready();console.log('FIXTURE_READY');await life.done;return 0});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, PA_STATE_DIR: dir, PA_DESKTOP: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  await new Promise<void>((yes, no) => {
    let errors = '';
    const timer = setTimeout(() => no(new Error(`fixture timeout: ${errors}`)), 30000);
    child.stderr?.on('data', (d) => {
      errors += String(d);
    });
    child.stdout?.on('data', (d) => {
      if (String(d).includes('FIXTURE_READY')) {
        clearTimeout(timer);
        yes();
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      no(new Error(`fixture early exit: ${errors}`));
    });
  });
  return child;
}
it('native private ACL plus actual CLI stop drains a separate lifecycle and releases kernel ownership', async () => {
  const dir = state();
  const child = await fixture(dir);
  expect(windowsNative(dir, 'probe')).toBe('busy');
  const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'stop'], {
    encoding: 'utf8',
    timeout: 55000,
    env: { ...process.env, PA_STATE_DIR: dir, PA_DESKTOP: 'off' },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('cierre limpio confirmado');
  expect(readFileSync(join(dir, 'drained'), 'utf8')).toBe('yes');
  expect(existsSync(join(dir, 'agent.pid'))).toBe(false);
  expect(windowsNative(dir, 'confirm')).toBe('free');
  if (child.exitCode === null) await new Promise((done) => child.once('exit', done));
  expect(child.exitCode).toBe(0);
}, 90000);
it('refuses a second owner, rejects forged requests, then accepts only the genuine stop', async () => {
  const dir = state();
  const child = await fixture(dir);
  await expect(openWindowsDaemonControl(dir, () => {})).rejects.toThrow('ocupado');
  const ready = JSON.parse(readFileSync(join(dir, 'control-win', 'ready.json'), 'utf8'));
  writeFileSync(
    join(dir, 'control-win', 'request.json'),
    JSON.stringify({ instanceId: ready.instanceId, nonce: 'a'.repeat(64), proof: '0'.repeat(64) }),
  );
  await new Promise((done) => setTimeout(done, 1500));
  expect(existsSync(join(dir, 'drained'))).toBe(false);
  expect(child.exitCode).toBe(null);
  await stopWindowsDaemon(dir);
}, 90000);
it('never confirms a failed drainer as clean', async () => {
  const dir = state();
  await fixture(dir, true);
  await expect(stopWindowsDaemon(dir)).rejects.toThrow('no limpio');
  expect(existsSync(join(dir, 'agent.pid.stale'))).toBe(true);
}, 90000);
it('rejects broad read DACL and a junction without stopping a PID or repairing ACL', async () => {
  const dir = state();
  windowsNative(dir, 'init');
  const script = `$p=$env:PA_TEST_DIR;$a=Get-Acl -LiteralPath $p;$s=New-Object Security.Principal.SecurityIdentifier('S-1-1-0');$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s,'Read','Allow')));Set-Acl -LiteralPath $p -AclObject $a`;
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { env: { ...process.env, PA_TEST_DIR: dir }, encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(() => windowsNative(dir, 'check')).toThrow('DACL');
  expect(existsSync(join(dir, 'control-win', 'ready.json'))).toBe(false);
  const alias = join(roots[roots.length - 1] ?? '', 'alias');
  symlinkSync(dir, alias, 'junction');
  expect(() => windowsNative(alias, 'check')).toThrow('DACL');
});
it('absent signed metadata never falls back to a PID signal', async () => {
  const dir = state();
  windowsNative(dir, 'init');
  writeFileSync(join(dir, 'agent.pid'), String(process.pid));
  await expect(stopWindowsDaemon(dir)).rejects.toThrow();
  expect(readFileSync(join(dir, 'agent.pid'), 'utf8')).toBe(String(process.pid));
});
