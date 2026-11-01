import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it as baseIt, expect } from 'vitest';
import { DaemonNotRunningError, stopDaemon } from '../src/daemon-control.js';

const it = process.platform === 'linux' ? baseIt : baseIt.skip;
const roots: string[] = [];
const holders: { kill: () => void }[] = [];
afterEach(() => {
  for (const h of holders.splice(0)) h.kill();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function brokenState(): string {
  const state = mkdtempSync(join(tmpdir(), 'pa-arranque-stop-linux-'));
  roots.push(state);
  chmodSync(state, 0o700);
  mkdirSync(join(state, 'control'), { mode: 0o700 });
  writeFileSync(join(state, 'control', 'ready.json'), '{"version":1,"instan', { mode: 0o600 });
  return state;
}

it('pa stop con un ready.json roto y nadie en marcha dice que no estaba en marcha', async () => {
  const state = brokenState();
  await expect(stopDaemon(state, 500)).rejects.toBeInstanceOf(DaemonNotRunningError);
  writeFileSync(join(state, 'control', 'owner.lock'), '', { mode: 0o600 });
  await expect(stopDaemon(state, 500)).rejects.toBeInstanceOf(DaemonNotRunningError);
});

it('si alguien tiene el candado, no finge que estaba parada', async () => {
  const state = brokenState();
  const lock = join(state, 'control', 'owner.lock');
  writeFileSync(lock, '', { mode: 0o600 });
  const holder = spawn('flock', ['--exclusive', lock, 'sh', '-c', 'echo held; sleep 30'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    detached: true,
  });
  holders.push({
    kill: () => {
      try {
        if (holder.pid) process.kill(-holder.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    },
  });
  await new Promise((r) => holder.stdout?.once('data', r));
  await expect(stopDaemon(state, 500)).rejects.toThrow('Metadata de control ilegible.');
});
