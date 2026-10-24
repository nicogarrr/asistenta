import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, it as baseIt, beforeEach, expect } from 'vitest';
import { stopDaemon } from '../src/daemon-control.js';

const it = process.platform === 'linux' ? baseIt : baseIt.skip;
let dir: string;
const children: ChildProcess[] = [];
// Mitigation, NOT a proven fix: a fixture daemon whose test runner died (timeout/kill) is
// re-parented and would run on. It now exits by itself once orphaned. The earlier
// incident (orphan fixture daemons + multi-GB logs in /tmp/pa-stop-*) was not reproduced.
const WATCHDOG = ';{const pp=process.ppid;setInterval(()=>{if(process.ppid!==pp)process.exit(3)},1000).unref();}';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-stop-'));
});
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      c.kill('SIGKILL');
      await new Promise((r) => c.once('exit', r));
    }
  }
  rmSync(dir, { recursive: true, force: true });
});
async function fixture(mode: 'clean' | 'fail' | 'hung' = 'clean', delay = 100) {
  const lifecycle = pathToFileURL(resolve('dist/lifecycle.js')).href;
  const wrapper = pathToFileURL(resolve('dist/controlled-daemon.js')).href;
  const code = `import {installLifecycle} from ${JSON.stringify(lifecycle)};import {controlledDaemon} from ${JSON.stringify(wrapper)};import {writeFileSync} from 'node:fs';
    await controlledDaemon(async ctl=>{const life=installLifecycle({name:'agent',shutdownBudgetMs:300,onShutdown:async()=>{${mode === 'hung' ? 'await new Promise(()=>{});' : `await new Promise(r=>setTimeout(r,${delay}));${mode === 'fail' ? "throw new Error('fixture failure');" : `writeFileSync(${JSON.stringify(join(dir, 'drained'))},'yes');`}`}}});ctl.attach(life);ctl.ready();console.log('ready');await life.done;return 0;});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code + WATCHDOG], {
    env: { ...process.env, PA_STATE_DIR: dir, PA_DESKTOP: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  await new Promise<void>((yes, no) => {
    const timer = setTimeout(() => no(new Error('fixture startup timeout')), 5000);
    child.stdout?.on('data', (chunk) => {
      if (chunk.toString().includes('ready')) {
        clearTimeout(timer);
        yes();
      }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      no(new Error('fixture exited before ready'));
    });
  });
  return child;
}
it('stops a real lifecycle child only after draining, removing PID and releasing ownership', async () => {
  const child = await fixture('clean', 150);
  const before = Date.now();
  await stopDaemon(dir);
  expect(Date.now() - before).toBeGreaterThanOrEqual(100);
  expect(readFileSync(join(dir, 'drained'), 'utf8')).toBe('yes');
  expect(existsSync(join(dir, 'agent.pid'))).toBe(false);
  if (child.exitCode === null) await new Promise((r) => child.once('exit', r));
  expect(child.exitCode).toBe(0);
});
it('runs the actual compiled CLI stop against an owned synthetic lifecycle fixture', async () => {
  const child = await fixture();
  const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'stop'], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, PA_STATE_DIR: dir, PA_DESKTOP: 'off' },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('cierre limpio confirmado');
  if (child.exitCode === null) await new Promise((r) => child.once('exit', r));
  expect(child.exitCode).toBe(0);
});
it('reports failed shutdown as non-clean and leaves the stale marker', async () => {
  const child = await fixture('fail');
  await expect(stopDaemon(dir, 1000)).rejects.toThrow('no fue limpio');
  if (child.exitCode === null) await new Promise((r) => child.once('exit', r));
  expect(child.exitCode).toBe(1);
  expect(existsSync(join(dir, 'agent.pid.stale'))).toBe(true);
});
it('does not report a hard-exit budget expiry as clean or start a replacement', async () => {
  const child = await fixture('hung');
  await expect(stopDaemon(dir, 700)).rejects.toThrow('no confirmada');
  if (child.exitCode === null) await new Promise((r) => child.once('exit', r));
  expect(child.exitCode).toBe(1);
  expect(existsSync(join(dir, 'drained'))).toBe(false);
});
it('rejects restart without touching the running instance', async () => {
  const child = await fixture();
  const before = readFileSync(join(dir, 'control', 'ready.json'));
  const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'restart'], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, PA_STATE_DIR: dir, PA_DESKTOP: 'off' },
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('supervisor');
  expect(readFileSync(join(dir, 'control', 'ready.json'))).toEqual(before);
  expect(child.exitCode).toBe(null);
  await stopDaemon(dir);
});

it('keeps the same OS ownership until a failed drainer process exits', async () => {
  const wrapper = pathToFileURL(resolve('dist/controlled-daemon.js')).href;
  const lifecycle = pathToFileURL(resolve('dist/lifecycle.js')).href;
  const code = `import {controlledDaemon} from ${JSON.stringify(wrapper)};import {installLifecycle} from ${JSON.stringify(lifecycle)};setInterval(()=>{},1000);await controlledDaemon(async ctl=>{const life=installLifecycle({name:'agent',onShutdown:async()=>{throw new Error('leaked resource fixture');}});ctl.attach(life);ctl.ready();console.log('ready');await life.done;return 0;});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code + WATCHDOG], {
    env: { ...process.env, PA_STATE_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  await new Promise<void>((yes, no) => {
    const t = setTimeout(() => no(new Error('startup timeout')), 5000);
    child.stdout?.once('data', () => {
      clearTimeout(t);
      yes();
    });
  });
  await expect(stopDaemon(dir, 1000)).rejects.toThrow('no fue limpio');
  const lock = spawnSync('flock', ['-n', join(dir, 'control', 'owner.lock'), 'true']);
  expect(lock.status).toBe(1);
  expect(child.exitCode).toBe(null);
});
it('does not touch an old daemon PID when authenticated metadata is absent', async () => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'agent.pid'), String(process.pid));
  await expect(stopDaemon(dir, 100)).rejects.toThrow();
  expect(readFileSync(join(dir, 'agent.pid'), 'utf8')).toBe(String(process.pid));
});

it('uses the actual 10-second thread-tail drain timeout and never writes a clean proof', async () => {
  const wrapper = pathToFileURL(resolve('dist/controlled-daemon.js')).href;
  const lifecycle = pathToFileURL(resolve('dist/lifecycle.js')).href;
  const drain = pathToFileURL(resolve('dist/shutdown-drain.js')).href;
  const code = `import {controlledDaemon} from ${JSON.stringify(wrapper)};import {installLifecycle} from ${JSON.stringify(lifecycle)};import {drainThreadTails} from ${JSON.stringify(drain)};await controlledDaemon(async ctl=>{const life=installLifecycle({name:'agent',onShutdown:async()=>{await drainThreadTails([new Promise(()=>{})]);}});ctl.attach(life);ctl.ready();console.log('ready');await life.done;return 0;});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code + WATCHDOG], {
    env: { ...process.env, PA_STATE_DIR: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  await new Promise<void>((yes, no) => {
    const t = setTimeout(() => no(new Error('startup timeout')), 5000);
    child.stdout?.once('data', () => {
      clearTimeout(t);
      yes();
    });
  });
  const start = Date.now();
  await expect(stopDaemon(dir, 12000)).rejects.toThrow('no fue limpio');
  expect(Date.now() - start).toBeGreaterThanOrEqual(9900);
  if (child.exitCode === null) await new Promise((r) => child.once('exit', r));
  expect(child.exitCode).toBe(1);
  expect(existsSync(join(dir, 'agent.pid.stale'))).toBe(true);
}, 15000);

it('blocks forced desktop on Linux before vault, channels or microphone startup', async () => {
  const { readdirSync } = await import('node:fs');
  const result = spawnSync(process.execPath, [resolve('dist/cli.js'), 'serve'], {
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, PA_STATE_DIR: dir, PA_DESKTOP: 'on' },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('requiere modo servidor');
  expect(readdirSync(dir).filter((name) => name !== 'log')).toEqual([]);
  expect(existsSync(join(dir, 'control'))).toBe(false);
  expect(existsSync(join(dir, 'agent.pid'))).toBe(false);
});
