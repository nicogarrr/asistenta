import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

import { AltavozStore } from '../src/audio/altavoz.js';
import { readAutoupdateState, writeAutoupdateState } from '../src/autoupdate.js';
import { MemoryStore } from '../src/memory.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'pa-estado-tmp3-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  block.on = false;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const leftovers = (dir: string) =>
  readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.tmp'));
const quietly = (fn: () => void) => {
  try {
    fn();
  } catch {
    // aquí solo importa lo que queda en la carpeta
  }
};

describe('guardados que ya no dejan .tmp cuando el rename falla', () => {
  it('memoria', () => {
    const dir = tmp();
    const mem = new MemoryStore(dir);
    mem.remember('chat1', 'me gusta el café');
    block.on = true;
    for (let i = 0; i < 3; i++) quietly(() => mem.remember('chat1', `dato ${i}`));
    expect(leftovers(dir)).toEqual([]);
    block.on = false;
    expect(new MemoryStore(dir).all('chat1').map((e) => e.text)).toContain('me gusta el café');
  });

  it('modo altavoz', () => {
    const dir = tmp();
    const file = join(dir, 'altavoz.json');
    block.on = true;
    for (let i = 0; i < 3; i++) quietly(() => new AltavozStore(file).set('c1', 'pc'));
    expect(leftovers(dir)).toEqual([]);
    block.on = false;
    new AltavozStore(file).set('c1', 'tele');
    expect(new AltavozStore(file).get('c1')).toBe('tele');
  });

  it('estado de autoactualización', () => {
    const dir = tmp();
    writeAutoupdateState(dir, { off: true });
    block.on = true;
    for (let i = 0; i < 3; i++) writeAutoupdateState(dir, { off: false });
    expect(leftovers(dir)).toEqual([]);
    expect(readAutoupdateState(dir).off).toBe(true);
  });
});
