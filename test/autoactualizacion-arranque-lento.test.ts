import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AutoupdateDeps, autoupdateHealthMs, runAutoupdate } from '../src/autoupdate.js';

// En el PC de Nico (31 oct, 23:12) la versión nueva tardó más de 120 s en escribir su
// agent.pid (lo hace al final del arranque) y la autoactualización volvió atrás.
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-autoupdate-lento-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** git, npm y daemon falsos; el daemon tarda `bootMs` (tiempo falso) en quedar «running». */
function fake(bootMs: number) {
  const sent: string[] = [];
  let t = Date.parse('2026-10-31T22:05:00Z');
  let state: 'running' | 'stopped' = 'running';
  let readyAt = Number.POSITIVE_INFINITY;
  const deps: AutoupdateDeps = {
    git: async (args) => {
      const cmd = args.join(' ');
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { code: 0, out: 'main\n' };
      if (cmd === 'rev-parse HEAD') return { code: 0, out: `${OLD}\n` };
      if (cmd === 'rev-parse origin/main') return { code: 0, out: `${NEW}\n` };
      if (args[0] === 'log') return { code: 0, out: 'Algo nuevo (#1)\n' };
      return { code: 0, out: '' };
    },
    npm: async () => ({ code: 0, out: '' }),
    daemonState: () => (state === 'running' || t >= readyAt ? 'running' : 'stopped'),
    busy: () => 'libre',
    stopDaemon: async () => {
      state = 'stopped';
      readyAt = Number.POSITIVE_INFINITY;
    },
    startDaemon: async () => {
      if (readyAt === Number.POSITIVE_INFINITY) readyAt = t + bootMs;
      return true;
    },
    backupDist: () => {},
    restoreDist: () => {},
    dropBackup: () => {},
    notify: async (text) => {
      sent.push(text);
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
  return { deps, sent };
}

describe('autoactualización con un arranque lento', () => {
  it('una versión que tarda 150 s en arrancar se queda (no vuelve atrás)', async () => {
    const f = fake(150_000);
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.kind).toBe('actualizada');
    expect(f.sent[0]).toContain('Me he actualizado');
  });

  it('si de verdad no arranca, vuelve atrás y dice cuánto esperó', async () => {
    const f = fake(Number.POSITIVE_INFINITY);
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.kind).toBe('revertida');
    expect(f.sent[0]).toContain('esperé 300 s');
  });

  it('PA_AUTOUPDATE_SALUD_SEG cambia la espera, entre 60 y 600 s', () => {
    expect(autoupdateHealthMs({})).toBe(300_000);
    expect(autoupdateHealthMs({ PA_AUTOUPDATE_SALUD_SEG: '420' })).toBe(420_000);
    expect(autoupdateHealthMs({ PA_AUTOUPDATE_SALUD_SEG: '5' })).toBe(60_000);
    expect(autoupdateHealthMs({ PA_AUTOUPDATE_SALUD_SEG: '99999' })).toBe(600_000);
    expect(autoupdateHealthMs({ PA_AUTOUPDATE_SALUD_SEG: 'mucho' })).toBe(300_000);
  });
});
