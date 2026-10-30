import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { daemonRunState } from '../src/autoupdate-cli.js';

const dirs: string[] = [];
function stateDir(pid: string, heartbeat?: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-runstate-pid-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'agent.pid'), pid);
  if (heartbeat !== undefined) writeFileSync(join(dir, 'agent.heartbeat'), `${heartbeat}\n`);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('daemonRunState: agent.pid vacío o roto', () => {
  it('pid vacío y sin latido: parada (el vigilante la relanza)', () => {
    expect(daemonRunState(stateDir(''))).toBe('stopped');
  });

  it('pid a medias y latido de hace una hora: parada', () => {
    expect(daemonRunState(stateDir('12ab', Date.now() - 3_600_000))).toBe('stopped');
  });

  it('pid roto pero latido reciente: sigue «dudoso», no se toca', () => {
    expect(daemonRunState(stateDir('basura', Date.now()))).toBe('unknown');
  });
});
