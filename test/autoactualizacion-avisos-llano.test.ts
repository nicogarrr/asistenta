import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AutoupdateDeps, runAutoupdate } from '../src/autoupdate.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const JERGA = /git|npm|commit|fast-forward|merge|compilación|sana|autostart|origin|HEAD/i;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-autoupdate-llano-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fake(o: {
  fail?: 'fetch' | 'merge' | 'ci' | 'build' | 'health' | 'reset';
  diverged?: boolean;
}) {
  let state: 'running' | 'stopped' = 'running';
  let t = Date.parse('2026-10-31T08:00:00Z');
  const sent: string[] = [];
  const deps: AutoupdateDeps = {
    git: async (args) => {
      const cmd = args.join(' ');
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { code: 0, out: 'main\n' };
      if (cmd === 'rev-parse HEAD') return { code: 0, out: `${OLD}\n` };
      if (cmd === 'rev-parse origin/main') return { code: 0, out: `${NEW}\n` };
      if (args[0] === 'fetch') return { code: o.fail === 'fetch' ? 1 : 0, out: '' };
      if (args[0] === 'merge-base') return { code: o.diverged ? 1 : 0, out: '' };
      if (args[0] === 'merge') return { code: o.fail === 'merge' ? 1 : 0, out: 'fatal: x' };
      if (args[0] === 'reset') return { code: o.fail === 'reset' ? 1 : 0, out: '' };
      if (args[0] === 'diff') return { code: 0, out: 'package-lock.json\n' };
      return { code: 0, out: '' };
    },
    npm: async (args) => {
      if (args[0] === 'ci') return { code: o.fail === 'ci' ? 1 : 0, out: 'npm ERR!' };
      return { code: o.fail === 'build' || o.fail === 'reset' ? 1 : 0, out: 'error TS' };
    },
    daemonState: () => state,
    busy: () => 'libre',
    stopDaemon: async () => {
      state = 'stopped';
    },
    startDaemon: async () => {
      if (o.fail !== 'health') state = 'running';
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

describe('autoactualización: avisos y estado en castellano llano', () => {
  it.each(['merge', 'ci', 'build', 'health', 'reset'] as const)(
    'si falla (%s), el aviso de Telegram no lleva jerga',
    async (fail) => {
      const f = fake({ fail });
      const out = await runAutoupdate(dir, f.deps, { env: {}, healthTimeoutMs: 20_000 });
      expect(out.kind).toBe('revertida');
      expect(f.sent).toHaveLength(1);
      const cuerpo = (f.sent[0] ?? '').replace('Detalle: pa autoupdate status', '');
      expect(cuerpo).not.toMatch(JERGA);
    },
  );

  it('sin internet o con la copia cambiada, el estado lo dice sin jerga', async () => {
    const sinRed = await runAutoupdate(dir, fake({ fail: 'fetch' }).deps, { env: {} });
    expect(sinRed.text).toContain('¿sin internet?');
    expect(sinRed.text).not.toMatch(JERGA);
    const div = await runAutoupdate(dir, fake({ diverged: true }).deps, { env: {}, force: true });
    expect(div.text).not.toMatch(JERGA);
  });
});
