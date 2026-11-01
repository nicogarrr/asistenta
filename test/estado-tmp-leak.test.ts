import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

import { maybeSendBootNotice } from '../src/boot-notice.js';
import { writeFileReplacing } from '../src/fs-tmp.js';
import { capAppendFile } from '../src/maintenance.js';
import { BUSY_DIR, busyBegin, trackBusyIn } from '../src/ocupada.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pa-estado-tmp-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  block.on = false;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const leftovers = (dir: string) => readdirSync(dir).filter((f) => f.endsWith('.tmp'));

describe('carpeta de estado: un rename fallido no deja .tmp', () => {
  it('writeFileReplacing relanza el error y borra su tmp', () => {
    const d = tmp();
    block.on = true;
    expect(() => writeFileReplacing(join(d, 'x.json'), '{}')).toThrow(/EPERM/);
    expect(leftovers(d)).toEqual([]);
    block.on = false;
    writeFileReplacing(join(d, 'x.json'), '{"a":1}');
    expect(readdirSync(d)).toEqual(['x.json']);
  });

  it('aviso de arranque (boot-notice.json)', async () => {
    const d = tmp();
    block.on = true;
    await maybeSendBootNotice({
      env: {},
      statePath: join(d, 'boot-notice.json'),
      ownerChatId: 1,
      send: async () => undefined,
      facts: { tv: false, computerUse: false, mail: false },
    }).catch(() => undefined);
    expect(leftovers(d)).toEqual([]);
  });

  it('contadores de ocupada (cada turno los reescribe)', () => {
    const d = tmp();
    block.on = true;
    trackBusyIn(d);
    busyBegin('turnos')();
    expect(leftovers(join(d, BUSY_DIR))).toEqual([]);
  });

  it('recorte de un registro que crece (capAppendFile)', () => {
    const d = tmp();
    mkdirSync(join(d, 'logs'));
    const file = join(d, 'logs', 'a.log');
    writeFileSync(file, `${'línea larga de registro\n'.repeat(200)}`);
    block.on = true;
    capAppendFile(file, 1024);
    expect(leftovers(join(d, 'logs'))).toEqual([]);
  });
});
