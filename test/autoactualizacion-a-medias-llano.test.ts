import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AutoupdateDeps,
  INTERRUPTED_MESSAGE,
  readAutoupdateState,
  runAutoupdate,
  writeAutoupdateState,
} from '../src/autoupdate.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-medias-llano-'));
  writeAutoupdateState(dir, { pending: { from: OLD, to: NEW, at: new Date().toISOString() } });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Arreglo de una actualización a medias en el que git no puede volver y no arranca. */
function fake(o: { resetFails: boolean; startFails: boolean }) {
  let t = Date.parse('2026-10-31T08:00:00Z');
  const sent: string[] = [];
  const deps: AutoupdateDeps = {
    git: async (args) => ({ code: args[0] === 'reset' && o.resetFails ? 128 : 0, out: '' }),
    npm: async () => ({ code: 0, out: '' }),
    daemonState: () => (o.startFails ? 'stopped' : 'running'),
    busy: () => 'libre',
    stopDaemon: async () => {},
    startDaemon: async () => !o.startFails,
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

const JERGA = /\bgit\b|\bcommit\b|\bnpm\b|\b[0-9a-f]{7}\b|\bsana\b/i;

describe('actualización a medias: avisos sin jerga', () => {
  it('si no puede volver del todo, lo dice llano en Telegram y en el estado', async () => {
    const { deps, sent } = fake({ resetFails: true, startFails: true });
    const out = await runAutoupdate(dir, deps, { healthTimeoutMs: 60_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.startsWith(INTERRUPTED_MESSAGE)).toBe(true);
    expect(sent[0]).toContain('no he podido volver del todo a la versión anterior');
    expect(sent[0]).toContain('pa doctor');
    expect(sent[0]).not.toMatch(JERGA);
    expect(out.text).not.toMatch(JERGA);
    expect(readAutoupdateState(dir).last?.text).not.toMatch(JERGA);
  });

  it('cuando todo va bien, el estado dice que volvió a la versión anterior', async () => {
    const { deps } = fake({ resetFails: false, startFails: false });
    const out = await runAutoupdate(dir, deps, { healthTimeoutMs: 60_000 });
    expect(out.kind).toBe('revertida');
    expect(out.text).toBe('se quedó a medias; he vuelto a la versión anterior');
  });
});
