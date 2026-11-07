import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AutoupdateDeps } from '../src/autoupdate.js';
import { UPDATE_SEARCHING } from '../src/autoupdate-boton.js';
import { autoupdateCommand, waitUntilFree } from '../src/autoupdate-cli.js';
import {
  createSelfUpdateTool,
  SELF_UPDATE_NOT_OWNER,
  SELF_UPDATE_STARTED,
  selfInstallBlock,
} from '../src/tools/actualizarme.js';
import { createShellTool } from '../src/tools/shell.js';

// Nico, 6 nov: le pidió a Asistenta por Telegram que se actualizara y ella hizo git pull y
// npm ci con su propio shell, con los .node de sherpa/onnxruntime bloqueados por ella misma:
// `npm ci` se quedó a medias y tuvo que acabarlo él en PowerShell. Ahora «actualízate» va por
// la herramienta «actualizarme» (el actualizador aparte del botón) y el shell lo rechaza.

const REPO = process.platform === 'win32' ? 'C:\\Users\\nico\\asistenta' : '/home/nico/asistenta';

describe('herramienta actualizarme', () => {
  it('fuera del chat privado del dueño no lanza nada', async () => {
    const start = vi.fn();
    const tool = createSelfUpdateTool({ allowed: () => false, start });
    const r = await tool.execute('1', {}, undefined);
    expect(r.content[0]).toMatchObject({ text: SELF_UPDATE_NOT_OWNER });
    expect(start).not.toHaveBeenCalled();
  });

  it('lanza el actualizador aparte y le dice al modelo que acabe el turno', async () => {
    const start = vi.fn(async () => ({ notice: UPDATE_SEARCHING }));
    const tool = createSelfUpdateTool({ allowed: () => true, start });
    const r = await tool.execute('1', {}, undefined);
    expect(start).toHaveBeenCalledTimes(1);
    expect(r.content[0]).toMatchObject({ text: SELF_UPDATE_STARTED });
    expect(r.details).toEqual({ started: true });
  });

  it('si ya hay una en marcha o está apagada, devuelve el motivo', async () => {
    const tool = createSelfUpdateTool({
      allowed: () => true,
      start: async () => ({
        notice: 'La autoactualización está apagada.',
        reply: 'pa autoupdate on',
      }),
    });
    const r = await tool.execute('1', {}, undefined);
    expect(r.details).toEqual({ started: false });
    expect((r.content[0] as { text: string }).text).toContain('pa autoupdate on');
  });

  it('la descripción le dice que nunca use el shell para actualizarse', () => {
    const tool = createSelfUpdateTool({ allowed: () => true, start: async () => ({ notice: '' }) });
    expect(tool.description).toMatch(/instead of running git pull, npm ci/);
  });
});

describe('selfInstallBlock: el shell no reinstala la propia Asistenta', () => {
  it.each([
    ['npm ci', REPO],
    ['git pull; npm ci; npm run build', REPO],
    ['git reset --hard origin/main', REPO],
    [`cd "${REPO}"; npm ci`, tmpdir()],
    [`Set-Location ${REPO}; git pull`, tmpdir()],
    [`npm --prefix ${REPO} ci`, tmpdir()],
  ])('bloquea «%s» (cwd %s)', (cmd, cwd) => {
    expect(selfInstallBlock(cmd, cwd, REPO)).toMatch(/actualizarme/);
  });

  it.each([
    ['git status', REPO],
    ['npm test', REPO],
    ['npm install sharp', tmpdir()],
    [`cd ${join(tmpdir(), 'otro')}; npm ci`, REPO],
  ])('deja pasar «%s» (cwd %s)', (cmd, cwd) => {
    expect(selfInstallBlock(cmd, cwd, REPO)).toBeNull();
  });

  it('en Windows el shell lo rechaza sin lanzar PowerShell', async () => {
    const spawn = vi.fn();
    const tool = createShellTool({ idleTimeoutMs: 600_000, toolTimeoutMs: 60_000 } as never, {
      spawn: spawn as never,
      platform: 'win32',
      env: {},
      selfRepo: process.cwd(),
    });
    const r = await tool.execute('1', { command: 'git pull; npm ci' }, undefined);
    expect(spawn).not.toHaveBeenCalled();
    expect((r.content[0] as { text: string }).text).toMatch(/actualizarme/);
  });
});

describe('el actualizador del botón espera a que acabe el turno', () => {
  function deps(busyTimes: number) {
    let t = 0;
    let left = busyTimes;
    const sent: string[] = [];
    const d: AutoupdateDeps = {
      git: async (args) => {
        const cmd = args.join(' ');
        if (cmd === 'rev-parse --abbrev-ref HEAD') return { code: 0, out: 'main\n' };
        if (cmd === 'rev-parse HEAD' || cmd === 'rev-parse origin/main')
          return { code: 0, out: `${'a'.repeat(40)}\n` };
        return { code: 0, out: '' };
      },
      npm: async () => ({ code: 0, out: '' }),
      daemonState: () => 'running',
      busy: () => (left-- > 0 ? 'ocupada' : 'libre'),
      stopDaemon: async () => {},
      startDaemon: async () => true,
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
    return { d, sent };
  }

  it('waitUntilFree: espera mientras está ocupada y para al quedar libre', async () => {
    const { d } = deps(3);
    expect(await waitUntilFree(d, 60_000)).toBe(true);
    expect(d.now()).toBe(9_000);
  });

  it('waitUntilFree: se rinde al tope', async () => {
    const { d } = deps(1_000);
    expect(await waitUntilFree(d, 30_000)).toBe(false);
  });

  it('pa autoupdate boton con el turno aún abierto: espera y revisa (no «aplazada»)', async () => {
    const { d, sent } = deps(5);
    const dir = mkdtempSync(join(tmpdir(), 'pa-autoupd1b-'));
    const code = await autoupdateCommand(['boton'], {
      stateDir: dir,
      repo: dir,
      deps: d,
      env: {},
      version: '1.0.0',
    });
    expect(code).toBe(0);
    expect(sent.join('\n')).toContain('Ya tienes la última versión');
  });
});
