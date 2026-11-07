import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AutoupdateDeps,
  npmCiFailReason,
  npmCiRetrying,
  runAutoupdate,
} from '../src/autoupdate.js';

// En Windows los .node de sherpa/onnxruntime se sueltan con unos segundos de retraso tras
// cerrarse Asistenta (o los retiene el antivirus): el primer `npm ci` choca con EPERM/EBUSY.
// Antes eso era «¿sin internet?» y vuelta atrás; ahora reintenta y, si sigue, lo dice claro.
// Y el aviso de éxito dice a qué versión (commit) se ha actualizado.

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-autoupd1c-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fake(ciOuts: { code: number; out: string }[]) {
  const calls: string[] = [];
  const sent: string[] = [];
  const slept: number[] = [];
  let state: 'running' | 'stopped' = 'running';
  let t = Date.parse('2026-11-07T13:00:00Z');
  const deps: AutoupdateDeps = {
    git: async (args) => {
      const cmd = args.join(' ');
      calls.push(`git ${cmd}`);
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { code: 0, out: 'main\n' };
      if (cmd === 'rev-parse HEAD') return { code: 0, out: `${OLD}\n` };
      if (cmd === 'rev-parse origin/main') return { code: 0, out: `${NEW}\n` };
      if (args[0] === 'diff') return { code: 0, out: 'package-lock.json\n' };
      if (args[0] === 'log') return { code: 0, out: 'fix: algo (#1)\n' };
      return { code: 0, out: '' };
    },
    npm: async (args) => {
      calls.push(`npm ${args.join(' ')}`);
      if (args[0] === 'ci') return ciOuts.shift() ?? { code: 0, out: '' };
      return { code: 0, out: '' };
    },
    daemonState: () => state,
    busy: () => 'libre',
    stopDaemon: async () => {
      state = 'stopped';
    },
    startDaemon: async () => {
      state = 'running';
      return true;
    },
    backupDist: () => {},
    restoreDist: () => {},
    dropBackup: () => {},
    notify: async (text) => {
      sent.push(text);
    },
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    now: () => t,
  };
  return { deps, calls, sent, slept };
}

const EPERM = {
  code: 1,
  out: 'npm error code EPERM\nnpm error syscall unlink\nnpm error path C:\\x\\onnxruntime_binding.node',
};

describe('npm ci con archivos bloqueados', () => {
  it('EPERM una vez: espera y reintenta, y la actualización sale bien', async () => {
    const f = fake([EPERM, { code: 0, out: '' }]);
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.kind).toBe('actualizada');
    expect(f.calls.filter((c) => c.startsWith('npm ci'))).toHaveLength(2);
    expect(f.slept).toContain(5_000);
  });

  it('EPERM siempre: dos reintentos y vuelta atrás con el motivo claro (no «sin internet»)', async () => {
    const f = fake([EPERM, EPERM, EPERM]);
    const out = await runAutoupdate(dir, f.deps, { env: {} });
    expect(out.kind).toBe('revertida');
    expect(out.text).toContain('seguía abierto');
    expect(out.text).not.toContain('sin internet');
    expect(f.sent.join('\n')).toContain('seguía abierto');
  });

  it('fallo de red: no reintenta y dice «sin internet»', async () => {
    const f = fake([{ code: 1, out: 'npm error code ENOTFOUND registry.npmjs.org' }]);
    const r = await npmCiRetrying(f.deps.npm, f.deps.sleep);
    expect(r.code).toBe(1);
    expect(f.calls.filter((c) => c.startsWith('npm ci'))).toHaveLength(1);
    expect(npmCiFailReason(r.out)).toContain('sin internet');
  });
});

describe('aviso de éxito', () => {
  it('dice la versión nueva (commit corto)', async () => {
    const f = fake([]);
    await runAutoupdate(dir, f.deps, { env: {} });
    expect(f.sent.at(-1)).toMatch(/Versión nueva: bbbbbbb$/);
  });
});
