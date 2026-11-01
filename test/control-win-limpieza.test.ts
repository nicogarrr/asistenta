import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneControlLeftovers } from '../src/windows-daemon-control.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const NOW = Date.parse('2026-10-31T08:00:00Z');
const id = (c: string) => c.repeat(64);
function dirWith(files: [string, number][]) {
  const d = mkdtempSync(join(tmpdir(), 'pa-control-win-'));
  roots.push(d);
  for (const [leaf, minAgo] of files) {
    writeFileSync(join(d, leaf), '{}');
    const t = (NOW - minAgo * 60_000) / 1000;
    utimesSync(join(d, leaf), t, t);
  }
  return d;
}
const unlink = (d: string) => (leaf: string) => rmSync(join(d, leaf));

describe('control-win: pruebas de parada viejas', () => {
  it('borra las viejas y deja la más reciente aunque sea vieja', () => {
    const d = dirWith([
      [`${id('a')}.stopped`, 600],
      [`${id('b')}.stopped`, 300],
      [`${id('c')}.stopped`, 60],
    ]);
    const removed = pruneControlLeftovers(d, unlink(d), NOW);
    expect(removed.sort()).toEqual([`${id('a')}.stopped`, `${id('b')}.stopped`]);
    expect(readdirSync(d)).toEqual([`${id('c')}.stopped`]);
  });

  it('no toca una reciente que un pa stop puede estar leyendo', () => {
    const d = dirWith([
      [`${id('a')}.stopped`, 2],
      [`${id('b')}.stopped`, 1],
      [`${id('c')}.tmp`, 3],
    ]);
    expect(pruneControlLeftovers(d, unlink(d), NOW)).toEqual([]);
    expect(readdirSync(d)).toHaveLength(3);
  });

  it('quita temporales viejos y nunca toca ready.json, request.json ni otros nombres', () => {
    const d = dirWith([
      ['ready.json', 900],
      ['request.json', 900],
      ['notas.stopped', 900],
      [`${id('d')}.tmp`, 900],
      [`${id('e')}.stopped`, 900],
    ]);
    expect(pruneControlLeftovers(d, unlink(d), NOW)).toEqual([`${id('d')}.tmp`]);
    expect(existsSync(join(d, 'ready.json'))).toBe(true);
    expect(existsSync(join(d, `${id('e')}.stopped`))).toBe(true);
  });

  it('un fallo al borrar o una carpeta que no existe no impide arrancar', () => {
    const d = dirWith([
      [`${id('a')}.stopped`, 600],
      [`${id('b')}.stopped`, 60],
    ]);
    const boom = () => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    };
    expect(pruneControlLeftovers(d, boom, NOW)).toEqual([]);
    expect(pruneControlLeftovers(join(d, 'no-existe'), boom, NOW)).toEqual([]);
  });
});
