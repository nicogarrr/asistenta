import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installLifecycle } from '../src/lifecycle.js';

describe('marcador .stale = contador de caídas', () => {
  it('una parada con código ≠ 0 que drena bien deja el marcador (cuenta como caída)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-lc-'));
    const lc = installLifecycle({
      name: 'crash',
      stateDir: dir,
      onShutdown: async () => {},
      onStartup: () => {
        throw new Error('arranque roto');
      },
    });
    await lc.done;
    expect(lc.outcome()).toBe('failed');
    expect(existsSync(join(dir, 'crash.pid.stale'))).toBe(true);
    expect(existsSync(join(dir, 'crash.pid'))).toBe(false);
  });
  it('una parada limpia (código 0) sigue borrando el marcador', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-lc-'));
    const lc = installLifecycle({ name: 'ok', stateDir: dir, onShutdown: async () => {} });
    lc.stop('test');
    await lc.done;
    expect(lc.outcome()).toBe('clean');
    expect(existsSync(join(dir, 'ok.pid.stale'))).toBe(false);
  });
});
