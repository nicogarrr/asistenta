import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AutoupdateDeps,
  launchSince,
  plainLogLine,
  readAutoupdateState,
  runAutoupdate,
} from '../src/autoupdate.js';
import { readLogTail } from '../src/autoupdate-cli.js';

// Nico (31 oct, 23:12) solo vio «no arrancó sana en 120 s»: ni si se cerró ni por qué.
// El lanzador de Windows ya lo deja en log/launcher.stderr.log; el aviso lo cuenta.
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const T0 = Date.parse('2026-10-31T22:05:00Z');
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-autoupdate-motivo-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const stamp = (ms: number) => new Date(ms).toISOString().replace('Z', '0000+00:00');

/** La versión nueva nunca queda «running»; `log(t)` es lo que el lanzador lleva escrito. */
function fake(log: ((t: number) => string) | null) {
  const sent: string[] = [];
  let t = T0;
  let state: 'running' | 'stopped' = 'running';
  let restored = false;
  const deps: AutoupdateDeps = {
    git: async (args) => {
      const cmd = args.join(' ');
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { code: 0, out: 'main\n' };
      if (cmd === 'rev-parse HEAD') return { code: 0, out: `${OLD}\n` };
      if (cmd === 'rev-parse origin/main') return { code: 0, out: `${NEW}\n` };
      return { code: 0, out: '' };
    },
    npm: async () => ({ code: 0, out: '' }),
    daemonState: () => state,
    busy: () => 'libre',
    stopDaemon: async () => {
      state = 'stopped';
    },
    startDaemon: async () => {
      // Solo la versión anterior (tras restaurar) vuelve sana.
      if (restored) state = 'running';
      return true;
    },
    restoreDist: () => {
      restored = true;
    },
    backupDist: () => {},
    dropBackup: () => {},
    notify: async (text) => {
      sent.push(text);
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    ...(log ? { launcherLog: () => log(t) } : {}),
  };
  return { deps, sent, elapsed: () => t - T0 };
}

describe('la autoactualización dice por qué no arrancó la versión nueva', () => {
  it('se cerró al arrancar: lo dice con su última línea, sin rutas ni tokens, y no espera más', async () => {
    const f = fake((t) =>
      t < T0 + 20_000
        ? `${stamp(T0 - 3_600_000)} inicio de serve (sin TTY)\n`
        : [
            `${stamp(T0 - 3_600_000)} inicio de serve (sin TTY)`,
            `${stamp(T0 + 1_000)} inicio de serve (sin TTY)`,
            'Error: Cannot find module C:\\Users\\nico\\asistenta\\dist\\x.js',
            'No puedo conectar con Telegram (bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA).',
            '    at Module._resolveFilename (node:internal/modules/cjs/loader:1)',
            `${stamp(T0 + 15_000)} serve termino: exit=1`,
          ].join('\r\n'),
    );
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.kind).toBe('revertida');
    expect(f.sent[0]).toContain(
      'la versión nueva se cerró al arrancar («No puedo conectar con Telegram (…).»)',
    );
    expect(f.sent[0]).not.toMatch(/AAAA|Users|nico/);
    expect(readAutoupdateState(dir).last?.text).toContain('se cerró al arrancar');
    expect(f.sent[0]).not.toContain('no he vuelto a arrancar');
    expect(f.elapsed()).toBeLessThan(120_000);
  });

  it('seguía arrancando: lo dice, con lo último que escribió', async () => {
    const f = fake(
      () => `${stamp(T0 + 2_000)} inicio de serve (sin TTY)\nCargando herramientas…\n`,
    );
    const out = await runAutoupdate(dir, f.deps, { env: {}, healthTimeoutMs: 60_000 });
    expect(out.kind).toBe('revertida');
    expect(f.sent[0]).toContain('seguía arrancando a los 60 s («Cargando herramientas…»)');
  });

  it('Windows no la abrió: lo dice', async () => {
    const f = fake(() => `${stamp(T0 - 3_600_000)} inicio de serve (sin TTY)\n`);
    const out = await runAutoupdate(dir, f.deps, { env: {}, healthTimeoutMs: 60_000 });
    expect(out.kind).toBe('revertida');
    expect(f.sent[0]).toContain('Windows no llegó a abrir la versión nueva en 60 s');
  });

  it('sin log del lanzador queda como antes', async () => {
    const f = fake(null);
    const out = await runAutoupdate(dir, f.deps, { env: {}, healthTimeoutMs: 60_000 });
    expect(out.kind).toBe('revertida');
    expect(f.sent[0]).toContain('no arrancaba bien (esperé 60 s)');
  });

  it('launchSince y plainLogLine', () => {
    const text = `2026-10-31T23:08:12.1234567+01:00 inicio de serve (sin TTY)\r\nhola\r\n`;
    expect(launchSince(text, Date.parse('2026-10-31T22:08:00Z'))).toEqual({
      started: true,
      exited: false,
      lastLine: 'hola',
    });
    expect(launchSince(text, Date.parse('2026-10-31T22:09:00Z')).started).toBe(false);
    expect(
      plainLogLine('2026-10-31T23:08:12+01:00 error del launcher: Falta /home/x/dist/cli.js'),
    ).toBe('Falta …');
    expect(plainLogLine(`${'x'.repeat(10)} ${'y '.repeat(120)}`).length).toBeLessThanOrEqual(160);
  });

  it('readLogTail lee el final del log y null si no existe', () => {
    mkdirSync(join(dir, 'log'));
    const file = join(dir, 'log', 'launcher.stderr.log');
    writeFileSync(file, `${'a'.repeat(100)}fin`);
    expect(readLogTail(file, 10)).toBe('aaaaaaafin');
    expect(readLogTail(join(dir, 'no-hay.log'))).toBeNull();
  });
});
