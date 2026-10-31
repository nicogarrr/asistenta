import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ probe: 'free' as 'free' | 'busy' }));
vi.mock('../src/windows-control-native.js', () => ({
  windowsNative: vi.fn((_state: string, mode: string) =>
    mode === 'probe' ? native.probe : 'free',
  ),
  windowsOwnership: vi.fn(async () => ({ alive: () => true, release: async () => {} })),
}));

import { DaemonNotRunningError } from '../src/daemon-control.js';
import { openWindowsDaemonControl, stopWindowsDaemon } from '../src/windows-daemon-control.js';

const roots: string[] = [];
afterEach(() => {
  native.probe = 'free';
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
/** ready.json cut short, as a power cut can leave it on NTFS. */
function brokenState(content = '{"version":1,"instan'): { state: string; ready: string } {
  const state = mkdtempSync(join(tmpdir(), 'pa-arranque-ready-'));
  roots.push(state);
  mkdirSync(join(state, 'control-win'));
  const ready = join(state, 'control-win', 'ready.json');
  writeFileSync(ready, content);
  return { state, ready };
}

describe('Windows: ready.json roto tras un apagón', () => {
  it('Asistenta vuelve a arrancar: el ready.json roto se quita en vez de bloquear el arranque', async () => {
    for (const content of ['', '{"version":1,"instan', '{"version":2}']) {
      const { state, ready } = brokenState(content);
      const ctl = await openWindowsDaemonControl(state, () => {});
      expect(existsSync(ready)).toBe(false);
      await ctl.close();
    }
  });

  it('pa stop con un ready.json roto y nadie en marcha dice «no estaba en marcha»', async () => {
    const { state } = brokenState();
    await expect(stopWindowsDaemon(state, 100)).rejects.toBeInstanceOf(DaemonNotRunningError);
  });

  it('pa stop con un ready.json roto y control ocupado no enseña el error crudo de JSON', async () => {
    native.probe = 'busy';
    const { state } = brokenState();
    const error = await stopWindowsDaemon(state, 100).catch((e: unknown) => e as Error);
    expect(error).not.toBeInstanceOf(DaemonNotRunningError);
    expect(error.message).toBe('Metadata Windows ilegible.');
  });
});
