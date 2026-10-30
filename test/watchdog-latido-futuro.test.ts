import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Watchdog } from '../src/watchdog.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const setup = (beatAt: number) => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-wd-futuro-'));
  dirs.push(dir);
  const file = join(dir, 'agent.heartbeat');
  writeFileSync(file, String(beatAt));
  return file;
};

describe('vigilante: latido fechado en el futuro (reloj corregido hacia atrás)', () => {
  const T0 = Date.parse('2026-10-31T08:00:00Z');
  const STALE = 120_000;

  it('si el latido no se renueva, acaba contando como parado y reinicia', async () => {
    let now = T0;
    let restarts = 0;
    const file = setup(T0 + 2 * 3_600_000); // escrito con el reloj 2 h adelantado
    const wd = new Watchdog({
      heartbeatFile: file,
      staleAfterMs: STALE,
      now: () => now,
      restart: () => {
        restarts += 1;
      },
    });
    expect((await wd.check()).healthy).toBe(true);
    now += STALE + 1_000;
    const v = await wd.check();
    expect(v.healthy).toBe(false);
    expect(v.staleMs).toBeGreaterThanOrEqual(STALE);
    expect(restarts).toBe(1);
    expect(wd.summary(v)).not.toBe('');
  });

  it('un daemon vivo que reescribe el latido con la hora buena sigue sano', async () => {
    let now = T0;
    const file = setup(T0 + 2 * 3_600_000);
    const wd = new Watchdog({
      heartbeatFile: file,
      staleAfterMs: STALE,
      now: () => now,
      restart: () => {},
    });
    expect((await wd.check()).healthy).toBe(true);
    now += STALE + 1_000;
    writeFileSync(file, String(now - 5_000));
    expect((await wd.check()).healthy).toBe(true);
  });

  it('un pequeño desfase (menos de 1 min) no cambia nada', async () => {
    let now = T0;
    const file = setup(T0 + 30_000);
    const wd = new Watchdog({
      heartbeatFile: file,
      staleAfterMs: STALE,
      now: () => now,
      restart: () => {},
    });
    expect((await wd.check()).healthy).toBe(true);
    now += 60_000;
    expect((await wd.check()).healthy).toBe(true);
  });
});
