import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watchdogDecide } from '../src/autostart-watchdog.js';
import { lockHeld, pidAlive, tryLock, unlock } from '../src/autoupdate.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-autoupdate-candado-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Candado reciente dejado por un proceso con este pid (como tras un apagón). */
function candado(pid: number | string) {
  mkdirSync(join(dir, 'autoupdate'), { recursive: true });
  writeFileSync(
    join(dir, 'autoupdate', 'en-curso.lock'),
    JSON.stringify({ pid, at: new Date().toISOString() }),
  );
}
const muerto = () => false;
const vivo = () => true;

describe('candado de la autoactualización tras apagar o reiniciar el PC', () => {
  it('un candado reciente de un proceso que ya no existe no cuenta', () => {
    candado(424242);
    expect(lockHeld(dir, Date.now(), muerto)).toBe(false);
    expect(tryLock(dir, Date.now(), muerto)).toBe(true);
    unlock(dir);
  });

  it('el vigilante arranca Asistenta en vez de esperar «actualizando»', () => {
    candado(424242);
    const d = watchdogDecide({
      enabled: true,
      state: 'stopped',
      updating: lockHeld(dir, Date.now(), muerto),
      bootAt: Date.now() - 10 * 60_000,
    });
    expect(d.action).toBe('start');
  });

  it('si el proceso sigue vivo, el candado se respeta', () => {
    candado(424242);
    expect(lockHeld(dir, Date.now(), vivo)).toBe(true);
    expect(tryLock(dir, Date.now(), vivo)).toBe(false);
  });

  it('un candado vacío o sin pid se respeta mientras no caduque', () => {
    candado('x');
    expect(lockHeld(dir, Date.now(), muerto)).toBe(true);
    writeFileSync(join(dir, 'autoupdate', 'en-curso.lock'), '');
    expect(lockHeld(dir, Date.now(), muerto)).toBe(true);
  });

  it('pidAlive: este proceso vive', () => {
    expect(pidAlive(process.pid)).toBe(true);
  });
});
