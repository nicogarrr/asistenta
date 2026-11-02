/**
 * Botón «🔄 Buscar actualización ahora» (Telegram, sin orden nueva): el daemon lanza
 * `pa autoupdate boton` aparte, una sola vez a la vez; solo el dueño; respeta
 * PA_AUTOUPDATE=0 / pa autoupdate off y avisa fuera de Windows. Todo falso: sin procesos,
 * sin git, sin Telegram de verdad.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  spawn: () => {
    throw new Error('los tests nunca lanzan procesos de verdad');
  },
}));

import { instaladoAutoupdateCommand } from '../src/actualizar-instalado.js';
import { type AutoupdateDeps, tryLock, unlock, writeAutoupdateState } from '../src/autoupdate.js';
import {
  createUpdateButton,
  UPDATE_ALREADY_RUNNING,
  UPDATE_BUTTON_LABEL,
  UPDATE_CALLBACK,
  UPDATE_SEARCHING,
  updateButtons,
} from '../src/autoupdate-boton.js';
import { autoupdateCommand, realAutoupdateDeps, sendOwnerTelegram } from '../src/autoupdate-cli.js';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-botonupd-'));
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function button(o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; fail?: boolean } = {}) {
  const launches: Array<() => void> = [];
  const press = createUpdateButton({
    stateDir: dir,
    platform: o.platform ?? 'win32',
    env: o.env ?? {},
    now: () => Date.now(),
    launch: (onExit) => {
      if (o.fail) throw new Error('ENOENT');
      launches.push(onExit);
    },
  });
  return { press, launches };
}

describe('botón Buscar actualización: en el daemon', () => {
  it('es un botón en línea con su callback, no una orden nueva', () => {
    expect(updateButtons()).toEqual([{ label: UPDATE_BUTTON_LABEL, action: UPDATE_CALLBACK }]);
    expect(UPDATE_BUTTON_LABEL).toBe('🔄 Buscar actualización ahora');
    expect(Buffer.byteLength(UPDATE_CALLBACK)).toBeLessThanOrEqual(64);
  });

  it('el dueño pulsa: contesta «Buscando actualización…» y lanza la búsqueda aparte', () => {
    const b = button();
    const r = b.press({ data: UPDATE_CALLBACK, isOwner: true });
    expect(r.notice).toBe(UPDATE_SEARCHING);
    expect(r.notice).toBe('Buscando actualización…');
    expect(r.reply).toBeUndefined();
    expect(b.launches).toHaveLength(1);
  });

  it('doble toque: una sola búsqueda; al acabar se puede volver a pulsar', () => {
    const b = button();
    b.press({ data: UPDATE_CALLBACK, isOwner: true });
    const again = b.press({ data: UPDATE_CALLBACK, isOwner: true });
    expect(again.notice).toBe(UPDATE_ALREADY_RUNNING);
    expect(b.launches).toHaveLength(1);
    b.launches[0]?.();
    expect(b.press({ data: UPDATE_CALLBACK, isOwner: true }).notice).toBe(UPDATE_SEARCHING);
    expect(b.launches).toHaveLength(2);
  });

  it('con otra actualización en curso (el vigilante) no lanza otra', () => {
    expect(tryLock(dir)).toBe(true);
    // El candado es de este mismo proceso en el test: se finge que es de otro.
    writeFileSync(join(dir, 'autoupdate', 'en-curso.lock'), JSON.stringify({ at: 'x' }));
    const b = button();
    expect(b.press({ data: UPDATE_CALLBACK, isOwner: true }).notice).toBe(UPDATE_ALREADY_RUNNING);
    expect(b.launches).toHaveLength(0);
    unlock(dir);
  });

  it('solo el dueño en su chat privado', () => {
    const b = button();
    const r = b.press({ data: UPDATE_CALLBACK, isOwner: false });
    expect(r.notice).toContain('solo funciona en el chat privado del dueño');
    expect(b.launches).toHaveLength(0);
  });

  it('PA_AUTOUPDATE=0: dice que está apagada y cómo encenderla, sin buscar', () => {
    const b = button({ env: { PA_AUTOUPDATE: '0' } });
    const r = b.press({ data: UPDATE_CALLBACK, isOwner: true });
    expect(r.notice).toBe('La autoactualización está apagada.');
    expect(r.reply).toContain('PA_AUTOUPDATE=0');
    expect(r.reply).toContain('PA_AUTOUPDATE=1');
    expect(b.launches).toHaveLength(0);
  });

  it('pa autoupdate off: dice que está apagada y que se enciende con pa autoupdate on', () => {
    writeAutoupdateState(dir, { off: true });
    const b = button();
    const r = b.press({ data: UPDATE_CALLBACK, isOwner: true });
    expect(r.reply).toContain('pa autoupdate on');
    expect(b.launches).toHaveLength(0);
  });

  it('fuera de Windows: cómo actualizar a mano', () => {
    const b = button({ platform: 'linux' });
    const r = b.press({ data: UPDATE_CALLBACK, isOwner: true });
    expect(r.reply).toContain('git pull, npm ci y npm run build');
    expect(b.launches).toHaveLength(0);
  });

  it('si no se puede lanzar, lo dice en claro', () => {
    const b = button({ fail: true });
    const r = b.press({ data: UPDATE_CALLBACK, isOwner: true });
    expect(r.reply).toContain('pa autoupdate now');
    // No se queda «buscando» para siempre: el siguiente toque lo vuelve a intentar.
    expect(b.press({ data: UPDATE_CALLBACK, isOwner: true }).notice).not.toBe(
      UPDATE_ALREADY_RUNNING,
    );
  });

  it('un callback desconocido con el mismo prefijo no lanza nada', () => {
    const b = button();
    b.press({ data: 'upd:otra', isOwner: true });
    expect(b.launches).toHaveLength(0);
  });
});

/** git, npm, daemon y Telegram falsos, como en test/autoupdate.test.ts. */
function fake(o: { head?: string; build?: number; busy?: 'libre' | 'ocupada' } = {}) {
  const sent: string[] = [];
  let state: 'running' | 'stopped' = 'running';
  let t = Date.parse('2026-11-02T15:00:00Z');
  const deps: AutoupdateDeps = {
    git: async (args) => {
      const cmd = args.join(' ');
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { code: 0, out: 'main\n' };
      if (cmd === 'rev-parse HEAD') return { code: 0, out: `${o.head ?? OLD}\n` };
      if (cmd === 'rev-parse origin/main') return { code: 0, out: `${NEW}\n` };
      if (args[0] === 'log') return { code: 0, out: 'fix: algo roto (#713)\nfeat: botón (#714)\n' };
      return { code: 0, out: '' };
    },
    npm: async (args) => ({ code: args[0] === 'ci' ? 0 : (o.build ?? 0), out: 'error TS: x' }),
    daemonState: () => state,
    busy: () => o.busy ?? 'libre',
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
      t += ms;
    },
    now: () => t,
  };
  return { deps, sent };
}

describe('pa autoupdate boton (lo que lanza el botón)', () => {
  it('al día: un aviso con la versión', async () => {
    const f = fake({ head: NEW });
    const code = await autoupdateCommand(['boton'], {
      stateDir: dir,
      repo: dir,
      deps: f.deps,
      env: {},
      version: '1.4.0',
    });
    expect(code).toBe(0);
    expect(f.sent).toEqual(['✅ Ya tienes la última versión: 1.4.0 (bbbbbbb). No hay nada nuevo.']);
  });

  it('versión nueva: avisa de que se actualiza y luego el aviso de siempre', async () => {
    const f = fake();
    const code = await autoupdateCommand(['boton'], {
      stateDir: dir,
      repo: dir,
      deps: f.deps,
      env: {},
    });
    expect(code).toBe(0);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[0]).toBe(
      '🔄 Hay una versión nueva (aaaaaaa → bbbbbbb, 2 cambios). Me actualizo ahora: me cierro un momento y te aviso aquí cuando vuelva.',
    );
    expect(f.sent[1]).toContain('Me he actualizado');
  });

  it('falla la versión nueva: un solo aviso de fallo, en castellano', async () => {
    const f = fake({ build: 1 });
    const code = await autoupdateCommand(['boton'], {
      stateDir: dir,
      repo: dir,
      deps: f.deps,
      env: {},
    });
    expect(code).toBe(1);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toContain('No he podido actualizarme: la versión nueva no se pudo preparar');
  });

  it('el mismo fallo repetido (que el aviso normal calla) sí se contesta al botón', async () => {
    writeAutoupdateState(dir, { failedRemote: NEW, failedAt: new Date().toISOString() });
    const f = fake({ build: 1 });
    await autoupdateCommand(['boton'], { stateDir: dir, repo: dir, deps: f.deps, env: {} });
    expect(f.sent.at(-1)).toContain(
      'No me he actualizado: falló (la versión nueva no se pudo preparar)',
    );
  });

  it('ocupada: lo dice y que vuelva a pulsar', async () => {
    const f = fake({ busy: 'ocupada' });
    await autoupdateCommand(['boton'], { stateDir: dir, repo: dir, deps: f.deps, env: {} });
    expect(f.sent).toEqual([
      '⏸️ Todavía no me actualizo: Asistenta está haciendo algo o esperando tu permiso: lo dejo para luego. Vuelve a pulsar el botón cuando acabe.',
    ]);
  });

  it('apagada: lo dice y cómo encenderla', async () => {
    const f = fake();
    await autoupdateCommand(['boton'], {
      stateDir: dir,
      repo: dir,
      deps: f.deps,
      env: { PA_AUTOUPDATE: '0' },
    });
    expect(f.sent[0]).toContain('PA_AUTOUPDATE=1');
  });

  it('boton no sale en la ayuda (es interno)', async () => {
    const { AUTOUPDATE_USAGE } = await import('../src/autoupdate-cli.js');
    expect(AUTOUPDATE_USAGE).not.toContain('boton');
  });
});

describe('avisos de la autoactualización con el botón', () => {
  it('sendOwnerTelegram puede llevar el botón', async () => {
    const bodies: string[] = [];
    const vault: Record<string, string> = {
      'telegram:allowedUserIds': '7',
      'telegram:botToken': 'tok',
    };
    const ok = await sendOwnerTelegram(
      'hola',
      {
        unlock: async () => {},
        get: async (k: string) => vault[k],
        fetch: (async (_u: string, init: { body: string }) => {
          bodies.push(init.body);
          return { ok: true, json: async () => ({ ok: true }) };
        }) as unknown as typeof fetch,
      },
      updateButtons(),
    );
    expect(ok).toBe(true);
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({
      chat_id: 7,
      text: 'hola',
      reply_markup: {
        inline_keyboard: [[{ text: UPDATE_BUTTON_LABEL, callback_data: UPDATE_CALLBACK }]],
      },
    });
  });

  it('los avisos reales (éxito, fallo, a medias) salen con el botón', async () => {
    const calls: unknown[][] = [];
    const deps = realAutoupdateDeps(dir, dir, async (...args: unknown[]) => {
      calls.push(args);
      return true;
    });
    await deps.notify('⚠️ No he podido actualizarme: x. Sigo con la versión anterior.');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toContain('No he podido actualizarme');
    expect(calls[0]?.[2]).toEqual(updateButtons());
  });
});

describe('copia instalada con el .exe', () => {
  it('el botón busca la versión publicada y contesta en el chat', async () => {
    const sent: string[] = [];
    const code = await instaladoAutoupdateCommand(['boton'], dir, {
      current: '1.4.0',
      platform: 'win32',
      fetch: (async () => ({
        ok: true,
        url: 'https://api.github.com/repos/nicogarrr/asistenta/releases/latest',
        headers: new Headers(),
        arrayBuffer: async () => new TextEncoder().encode(JSON.stringify({ tag_name: 'v1.4.0' })),
      })) as unknown as typeof fetch,
      out: () => {},
      notify: async (t: string) => {
        sent.push(t);
      },
    });
    expect(code).toBe(0);
    expect(sent).toEqual(['Ya tienes la última versión (1.4.0).']);
  });
});
