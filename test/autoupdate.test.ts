import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AutoupdateDeps,
  autoupdateDue,
  autoupdateEnabled,
  autoupdateIntervalMin,
  cleanSubject,
  formatChangelog,
  lockHeld,
  readAutoupdateState,
  runAutoupdate,
  successMessage,
  tryLock,
  unlock,
  writeAutoupdateState,
} from '../src/autoupdate.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-autoupdate-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('candado y estado', () => {
  it('dos revisiones nunca se pisan', () => {
    expect(tryLock(dir)).toBe(true);
    expect(tryLock(dir)).toBe(false);
    expect(lockHeld(dir)).toBe(true);
    unlock(dir);
    expect(lockHeld(dir)).toBe(false);
  });

  it('un candado de un proceso muerto (viejo) se reemplaza', () => {
    expect(tryLock(dir)).toBe(true);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(join(dir, 'autoupdate', 'en-curso.lock'), old, old);
    expect(lockHeld(dir)).toBe(false);
    expect(tryLock(dir)).toBe(true);
  });

  it('PA_AUTOUPDATE=0 o pa autoupdate off la apagan; encendida por defecto', () => {
    expect(autoupdateEnabled(dir, {})).toBe(true);
    expect(autoupdateEnabled(dir, { PA_AUTOUPDATE: '0' })).toBe(false);
    writeAutoupdateState(dir, { off: true });
    expect(readAutoupdateState(dir).off).toBe(true);
    expect(autoupdateEnabled(dir, {})).toBe(false);
    expect(autoupdateIntervalMin({})).toBe(30);
    expect(autoupdateIntervalMin({ PA_AUTOUPDATE_INTERVAL_MIN: '1' })).toBe(5);
  });
});

/** git, npm, daemon y Telegram falsos: nada real se ejecuta. */
function fake(
  o: {
    head?: string;
    branch?: string;
    dirty?: string;
    ancestor?: boolean;
    lockChanged?: boolean;
    build?: number;
    ci?: number;
    busy?: 'libre' | 'ocupada' | 'desconocido';
    healthy?: boolean;
    /** Cuántos arranques ignora Windows (la tarea aún figuraba en marcha). */
    ignoredStarts?: number;
  } = {},
) {
  const calls: string[] = [];
  const sent: string[] = [];
  let state: 'running' | 'stopped' = 'running';
  let ignored = o.ignoredStarts ?? 0;
  let t = Date.parse('2026-10-30T18:00:00Z');
  const deps: AutoupdateDeps = {
    git: async (args) => {
      calls.push(`git ${args.join(' ')}`);
      const cmd = args.join(' ');
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { code: 0, out: `${o.branch ?? 'main'}\n` };
      if (cmd === 'rev-parse HEAD') return { code: 0, out: `${o.head ?? OLD}\n` };
      if (cmd === 'rev-parse origin/main') return { code: 0, out: `${NEW}\n` };
      if (args[0] === 'status') return { code: 0, out: o.dirty ?? '' };
      if (args[0] === 'merge-base') return { code: o.ancestor === false ? 1 : 0, out: '' };
      if (args[0] === 'log') {
        return {
          code: 0,
          out: 'feat(tele): sube a tope (#712)\nfix: algo roto (#713)\nfix: algo roto\n',
        };
      }
      if (args[0] === 'diff') return { code: 0, out: o.lockChanged ? 'package-lock.json\n' : '' };
      return { code: 0, out: '' };
    },
    npm: async (args) => {
      calls.push(`npm ${args.join(' ')}`);
      if (args[0] === 'ci') return { code: o.ci ?? 0, out: 'ci out' };
      return { code: o.build ?? 0, out: 'error TS2322: boom' };
    },
    daemonState: () => state,
    busy: () => o.busy ?? 'libre',
    stopDaemon: async () => {
      calls.push('stop');
      state = 'stopped';
    },
    startDaemon: async () => {
      calls.push('start');
      if (ignored-- > 0) return true;
      if (o.healthy !== false) state = 'running';
      return true;
    },
    backupDist: () => calls.push('backup'),
    restoreDist: () => calls.push('restore'),
    dropBackup: () => calls.push('drop'),
    notify: async (text) => {
      sent.push(text);
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
  return { deps, calls, sent };
}

describe('runAutoupdate', () => {
  it('al día: no toca nada ni avisa', async () => {
    const f = fake({ head: NEW });
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.kind).toBe('al-dia');
    expect(f.calls.some((c) => c.startsWith('git merge') || c === 'stop')).toBe(false);
    expect(f.sent).toEqual([]);
  });

  it('por delante y limpio: fast-forward, compila, reinicia y avisa con la lista', async () => {
    const f = fake();
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.kind).toBe('actualizada');
    const order = f.calls.filter((c) => /^(stop|start|backup|drop|git merge |npm )/.test(c));
    expect(order).toEqual([
      'backup',
      'stop',
      `git merge --ff-only --quiet ${NEW}`,
      'npm run build',
      'start',
      'drop',
    ]);
    expect(f.sent).toEqual(['🆕 Me he actualizado\n• Sube a tope\n• Algo roto']);
    expect(readAutoupdateState(dir).lastUpdateAt).toBeTruthy();
    expect(lockHeld(dir)).toBe(false);
  });

  it('npm ci solo si cambió package-lock.json', async () => {
    const f = fake({ lockChanged: true });
    await runAutoupdate(dir, f.deps, { env: {} });
    expect(f.calls).toContain('npm ci --no-audit --no-fund');
    const g = fake();
    await runAutoupdate(mkdtempSync(join(tmpdir(), 'pa-au2-')), g.deps, { env: {} });
    expect(g.calls.some((c) => c.startsWith('npm ci'))).toBe(false);
  });

  it('cambios locales: no actualiza y dice por qué', async () => {
    const f = fake({ dirty: ' M src/cli.ts\n' });
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out).toMatchObject({ kind: 'omitida' });
    expect(out.text).toContain('cambios locales');
    expect(f.calls.some((c) => c.startsWith('git merge') || c === 'stop')).toBe(false);
  });

  it('divergida (no es fast-forward): no toca nada', async () => {
    const f = fake({ ancestor: false });
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.text).toContain('fast-forward');
    expect(f.calls.some((c) => c.startsWith('git merge --') || c.startsWith('git reset'))).toBe(
      false,
    );
  });

  it('otra rama: nunca la toca (ni hace fetch)', async () => {
    const f = fake({ branch: 'mi-rama' });
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.text).toContain('mi-rama');
    expect(f.calls).toEqual(['git rev-parse --abbrev-ref HEAD']);
  });

  it('falla la compilación: vuelve al commit y dist de antes, rearranca y avisa en español', async () => {
    const f = fake({ build: 1, lockChanged: true });
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.kind).toBe('revertida');
    expect(f.calls).toContain(`git reset --keep ${OLD}`);
    expect(f.calls.filter((c) => c.startsWith('npm ci'))).toHaveLength(2);
    expect(f.calls).toContain('restore');
    expect(f.calls.at(-1)).toBe('start');
    expect(f.sent).toEqual([
      '⚠️ No he podido actualizarme: la compilación (npm run build) falló. Sigo con la versión anterior.\nDetalle: pa autoupdate status',
    ]);
  });

  it('si Windows ignora el primer arranque, lo vuelve a pedir y no revierte', async () => {
    const f = fake({ ignoredStarts: 1 });
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.kind).toBe('actualizada');
    expect(f.calls.filter((c) => c === 'start')).toHaveLength(2);
  });

  it('no vuelve sana tras actualizar: revierte', async () => {
    const f = fake({ healthy: false });
    const out = await runAutoupdate(dir, f.deps, { env: {}, healthTimeoutMs: 20_000 });
    expect(out.kind).toBe('revertida');
    expect(f.calls).toContain('restore');
    expect(f.sent[0]).toContain('no arrancó sana en 20 s');
  });

  it('ocupada o sin saberlo: aplaza sin parar el daemon, y vuelve a mirar en la próxima pasada', async () => {
    for (const busy of ['ocupada', 'desconocido'] as const) {
      const f = fake({ busy });
      const out = await runAutoupdate(dir, f.deps, { env: {} });
      expect(out.kind).toBe('aplazada');
      expect(f.calls).not.toContain('stop');
      expect(readAutoupdateState(dir).lastCheckAt).toBeUndefined();
    }
  });

  it('candado cogido: no hace nada', async () => {
    expect(tryLock(dir)).toBe(true);
    const f = fake();
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.text).toContain('en curso');
    expect(f.calls).toEqual([]);
    expect(lockHeld(dir)).toBe(true);
  });

  it('un candado de un proceso muerto (viejo) se reemplaza', () => {
    expect(tryLock(dir)).toBe(true);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(join(dir, 'autoupdate', 'en-curso.lock'), old, old);
    expect(lockHeld(dir)).toBe(false);
    expect(tryLock(dir)).toBe(true);
  });

  it('PA_AUTOUPDATE=0 o pa autoupdate off: no hace nada', async () => {
    const f = fake();
    expect((await runAutoupdate(dir, f.deps, { env: { PA_AUTOUPDATE: '0' } })).text).toContain(
      'apagada',
    );
    writeAutoupdateState(dir, { off: true });
    expect((await runAutoupdate(dir, f.deps, { env: {} })).text).toContain('apagada');
    expect(f.calls).toEqual([]);
  });

  it('como mucho una actualización cada 30 min (salvo pa autoupdate now)', async () => {
    const f = fake();
    writeAutoupdateState(dir, { lastUpdateAt: new Date(f.deps.now() - 10 * 60_000).toISOString() });
    expect((await runAutoupdate(dir, f.deps, { env: {} })).text).toContain('30 min');
    expect((await runAutoupdate(dir, f.deps, { env: {}, force: true })).kind).toBe('actualizada');
  });
});

describe('una versión que falla', () => {
  it('avisa una sola vez y no la reintenta cada 30 min', async () => {
    const f = fake({ build: 1 });
    expect((await runAutoupdate(dir, f.deps, { env: {} })).kind).toBe('revertida');
    expect(f.sent).toHaveLength(1);
    await f.deps.sleep(31 * 60_000);
    const calls = f.calls.length;
    const again = await runAutoupdate(dir, f.deps, { env: {} });
    expect(again.kind).toBe('omitida');
    expect(again.text).toContain('ya falló');
    expect(f.calls.slice(calls)).not.toContain('stop');
    expect(f.sent).toHaveLength(1);
    await f.deps.sleep(7 * 60 * 60_000);
    expect((await runAutoupdate(dir, f.deps, { env: {} })).kind).toBe('revertida');
    expect(f.sent).toHaveLength(1);
  });

  it('pa autoupdate now la reintenta ya, y una versión nueva se prueba normal', async () => {
    const f = fake({ build: 1 });
    await runAutoupdate(dir, f.deps, { env: {} });
    expect((await runAutoupdate(dir, f.deps, { env: {}, force: true })).kind).toBe('revertida');
    writeAutoupdateState(dir, { ...readAutoupdateState(dir), failedRemote: 'c'.repeat(40) });
    const ok = fake();
    expect((await runAutoupdate(dir, ok.deps, { env: {} })).kind).toBe('actualizada');
    expect(readAutoupdateState(dir).failedRemote).toBeUndefined();
  });
});

describe('candado durante una actualización larga', () => {
  it('sigue cogido aunque npm ci y la compilación tarden más de 45 min', async () => {
    const f = fake({ build: 1, lockChanged: true });
    let now = Date.now();
    const held: boolean[] = [];
    const deps: AutoupdateDeps = {
      ...f.deps,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      npm: async (args, timeoutMs) => {
        held.push(lockHeld(dir, now));
        now += 30 * 60_000;
        return f.deps.npm(args, timeoutMs);
      },
    };
    expect((await runAutoupdate(dir, deps, { env: {} })).kind).toBe('revertida');
    expect(held).toEqual([true, true, true]);
  });
});

describe('changelog', () => {
  it('quita prefijos y números de PR, deduplica y corta en 8 con «y N cambios más»', () => {
    expect(cleanSubject('feat(arranque)!: vigilante de Windows (#746)')).toBe(
      'Vigilante de Windows',
    );
    expect(cleanSubject('refactor: x')).toBe('X');
    const many = Array.from({ length: 11 }, (_, i) => `fix: cambio ${i}`);
    const lines = formatChangelog([...many, 'fix: cambio 0', 'Merge branch main']);
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe('• Cambio 0');
    expect(lines.at(-1)).toBe('y 3 cambios más');
    expect(formatChangelog(['a', 'b', 'c'], 2).at(-1)).toBe('y 1 cambio más');
    expect(successMessage([])).toBe('🆕 Me he actualizado\n• Cambios internos');
  });

  it('autoupdateDue respeta el intervalo', () => {
    const now = Date.parse('2026-10-30T18:00:00Z');
    expect(autoupdateDue({}, now, 30)).toBe(true);
    expect(autoupdateDue({ lastCheckAt: '2026-10-30T17:45:00Z' }, now, 30)).toBe(false);
    expect(autoupdateDue({ lastCheckAt: '2026-10-30T17:29:00Z' }, now, 30)).toBe(true);
  });
});
