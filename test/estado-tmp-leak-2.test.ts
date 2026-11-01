import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// En Windows el rename falla (EPERM) si otro programa tiene abierto el destino.
const block = { on: false };
vi.mock('node:fs', async (orig) => {
  const fs = await orig<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      if (block.on && String(from).endsWith('.tmp')) {
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      return fs.renameSync(from, to);
    },
  };
});

import { saveSeen } from '../src/alerts/inbox.js';
import { CommandRoutineStore } from '../src/command-routine.js';
import { installLifecycle } from '../src/lifecycle.js';
import { saveCommandCursor } from '../src/mail/command-inbox.js';
import { ModelChoiceStore } from '../src/model-choice.js';
import { OneTapIds } from '../src/one-tap-ids.js';
import { RoutineDeliveryStore } from '../src/routine-delivery.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pa-estado-tmp2-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  block.on = false;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const leftovers = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));
const quietly = (fn: () => void) => {
  try {
    fn();
  } catch {
    // aquí solo importa lo que queda en la carpeta
  }
};

describe('carpeta de estado: más guardados sin .tmp huérfano si el rename falla', () => {
  it('latido del daemon (installLifecycle)', async () => {
    const d = tmp();
    block.on = true;
    const lc = installLifecycle({ name: 'beat', stateDir: d, onShutdown: async () => {} });
    await lc.heartbeat();
    await lc.heartbeat();
    expect(leftovers(d)).toEqual([]);
    block.on = false;
    await lc.heartbeat();
    expect(readdirSync(d)).toContain('beat.heartbeat');
    lc.stop('test');
    await lc.done;
    expect(leftovers(d)).toEqual([]);
  });

  it('ids de botones de un toque (one-tap-ids)', () => {
    const d = tmp();
    const file = join(d, 'one-tap.json');
    const ids = new OneTapIds<string>({ ttlMs: 60_000, file });
    block.on = true;
    ids.remember('a');
    expect(leftovers(d)).toEqual([]);
    block.on = false;
    ids.remember('b');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('modelo elegido por chat (model-choice)', () => {
    const d = tmp();
    const store = new ModelChoiceStore(join(d, 'model-choice.json'));
    block.on = true;
    quietly(() => store.set('chat:1', 'm1'));
    expect(leftovers(d)).toEqual([]);
  });

  it('rutinas de comando (command-routine)', () => {
    const d = tmp();
    const store = new CommandRoutineStore(join(d, 'command-routines.json'));
    block.on = true;
    quietly(() =>
      store.propose('s', 'n', {
        argv: ['echo', 'x'],
        cwd: d,
        timeoutMs: 1000,
        schedule: '0 9 * * *',
        createdAt: new Date(0).toISOString(),
      }),
    );
    expect(leftovers(d)).toEqual([]);
  });

  it('entrega de rutinas (routine-delivery)', () => {
    const d = tmp();
    const store = new RoutineDeliveryStore(join(d, 'routine-delivery.json'));
    block.on = true;
    quietly(() => store.set('s', 'n', { target: 'chat', soloSiCambia: true }));
    expect(leftovers(d)).toEqual([]);
  });

  it('deduplicado de alertas (alerts/inbox)', () => {
    const d = tmp();
    block.on = true;
    saveSeen(join(d, 'alerts-seen.json'), new Map([['a', 1]]));
    expect(leftovers(d)).toEqual([]);
  });

  it('cursor del buzón de órdenes (mail/command-inbox)', () => {
    const d = tmp();
    block.on = true;
    expect(() => saveCommandCursor(join(d, 'cursor.json'), { validity: '1', next: 2 })).toThrow(
      /EPERM/,
    );
    expect(leftovers(d)).toEqual([]);
  });
});
