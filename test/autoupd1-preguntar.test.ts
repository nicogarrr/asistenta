import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AutoupdateDeps,
  autoupdateAsks,
  readAutoupdateState,
  runAutoupdate,
} from '../src/autoupdate.js';
import {
  createUpdateButton,
  offerButtons,
  UPDATE_CALLBACK,
  UPDATE_LATER_CALLBACK,
  UPDATE_LATER_NOTICE,
} from '../src/autoupdate-boton.js';

// PA_AUTOUPDATE_MODO=preguntar: el vigilante nunca instala sin un toque del dueño. Cuando
// main se mueve, una vez al día como mucho, pregunta por Telegram con «Actualizar» / «Luego».

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-autoupd1d-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fake() {
  const calls: string[] = [];
  const offers: string[] = [];
  let t = Date.parse('2026-11-07T13:00:00Z');
  const deps: AutoupdateDeps = {
    git: async (args) => {
      const cmd = args.join(' ');
      calls.push(`git ${cmd}`);
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { code: 0, out: 'main\n' };
      if (cmd === 'rev-parse HEAD') return { code: 0, out: `${OLD}\n` };
      if (cmd === 'rev-parse origin/main') return { code: 0, out: `${NEW}\n` };
      if (args[0] === 'log') return { code: 0, out: 'fix: uno (#1)\nfeat: dos (#2)\n' };
      return { code: 0, out: '' };
    },
    npm: async (args) => {
      calls.push(`npm ${args.join(' ')}`);
      return { code: 0, out: '' };
    },
    daemonState: () => 'running',
    busy: () => 'libre',
    stopDaemon: async () => {
      calls.push('stop');
    },
    startDaemon: async () => true,
    backupDist: () => {},
    restoreDist: () => {},
    dropBackup: () => {},
    notify: async () => {},
    offer: async (text) => {
      offers.push(text);
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
  return {
    deps,
    calls,
    offers,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const ASK = { PA_AUTOUPDATE_MODO: 'preguntar' };

describe('modo preguntar', () => {
  it('se activa solo con PA_AUTOUPDATE_MODO=preguntar', () => {
    expect(autoupdateAsks({})).toBe(false);
    expect(autoupdateAsks(ASK)).toBe(true);
  });

  it('el vigilante ofrece con botones y no para ni instala nada', async () => {
    const f = fake();
    const out = await runAutoupdate(dir, f.deps, { env: ASK });
    expect(out.kind).toBe('omitida');
    expect(f.offers).toHaveLength(1);
    expect(f.offers[0]).toContain('bbbbbbb, 2 cambios');
    expect(f.calls).not.toContain('stop');
    expect(f.calls.some((c) => /merge --ff|reset|npm/.test(c))).toBe(false);
    expect(readAutoupdateState(dir).offeredAt).toBeTruthy();
  });

  it('como mucho una oferta al día', async () => {
    const f = fake();
    await runAutoupdate(dir, f.deps, { env: ASK });
    f.advance(60 * 60_000);
    await runAutoupdate(dir, f.deps, { env: ASK });
    expect(f.offers).toHaveLength(1);
    f.advance(24 * 60 * 60_000);
    await runAutoupdate(dir, f.deps, { env: ASK });
    expect(f.offers).toHaveLength(2);
  });

  it('«Actualizar» (force, el botón) sí instala', async () => {
    const f = fake();
    const out = await runAutoupdate(dir, f.deps, { env: ASK, force: true });
    expect(out.kind).toBe('actualizada');
    expect(f.offers).toHaveLength(0);
  });

  it('los botones: «Actualizar» lanza el actualizador, «Luego» no lanza nada', () => {
    expect(offerButtons().map((b) => b.action)).toEqual([UPDATE_CALLBACK, UPDATE_LATER_CALLBACK]);
    let launched = 0;
    const press = createUpdateButton({
      stateDir: dir,
      platform: 'win32',
      env: {},
      now: () => 0,
      launch: () => {
        launched++;
      },
    });
    expect(press({ data: UPDATE_LATER_CALLBACK, isOwner: true }).notice).toBe(UPDATE_LATER_NOTICE);
    expect(launched).toBe(0);
    press({ data: UPDATE_CALLBACK, isOwner: true });
    expect(launched).toBe(1);
  });
});
