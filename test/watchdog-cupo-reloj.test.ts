import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Watchdog } from '../src/watchdog.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('vigilante: cupo de reinicios tras un reloj que va hacia atrás', () => {
  it('reinicios fechados en el futuro no dejan el cupo lleno durante horas', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-wd-cupo-'));
    dirs.push(dir);
    const T0 = Date.parse('2026-10-31T08:00:00Z');
    let now = T0;
    let restarts = 0;
    const wd = new Watchdog({
      heartbeatFile: join(dir, 'agent.heartbeat'), // sin latido: parado
      staleAfterMs: 120_000,
      maxRestarts: 2,
      windowMs: 15 * 60_000,
      now: () => now,
      restart: () => {
        restarts += 1;
      },
    });
    expect((await wd.check()).action).toBe('restart');
    expect((await wd.check()).action).toBe('restart');
    expect((await wd.check()).gaveUp).toBe(true);
    // Al volver de hibernar Windows corrige la hora 2 h hacia atrás.
    now = T0 - 2 * 3_600_000;
    const v = await wd.check();
    expect(v.action).toBe('restart');
    expect(restarts).toBe(3);
  });
});
