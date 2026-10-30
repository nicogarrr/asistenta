import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/memory.js';

// Otro proceso (el CLI `pa`) editando la misma memoria mientras el daemon guarda:
// toma el lock, lee, tarda un poco y escribe su versión. Sin lock entre procesos
// el daemon escribía en medio y el CLI pisaba su hecho al renombrar.
const OTHER_WRITER = `
const fs = require('node:fs');
const file = process.argv[1];
fs.writeFileSync(file + '.lock', String(process.pid), { flag: 'wx' });
const before = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file + '.ready', '');
setTimeout(() => {
  fs.writeFileSync(file, before.trimEnd() + '\\n- [cccccccc] (2026-10-30) hecho del CLI\\n');
  fs.unlinkSync(file + '.lock');
}, 400);
`;

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('memoria entre procesos', () => {
  it('un guardado del daemon espera al lock del CLI y no se pierde ningún hecho', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-lock-'));
    const store = new MemoryStore(dir);
    const scope = 'telegram:dm:1';
    store.remember(scope, 'hecho inicial');
    const file = store.fileFor(scope);
    const child = spawn(process.execPath, ['-e', OTHER_WRITER, file], { stdio: 'ignore' });
    const exited = new Promise((r) => child.on('exit', r));
    await until(() => existsSync(`${file}.ready`));
    store.remember(scope, 'hecho del daemon');
    await exited;
    const texts = store.all(scope).map((e) => e.text);
    expect(texts).toEqual(
      expect.arrayContaining(['hecho inicial', 'hecho del CLI', 'hecho del daemon']),
    );
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('un lock de un proceso muerto no bloquea la memoria', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-lock-'));
    const store = new MemoryStore(dir);
    const file = store.fileFor('s');
    writeFileSync(`${file}.lock`, '2147483646');
    const t0 = Date.now();
    store.remember('s', 'sigue funcionando');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(store.all('s').map((e) => e.text)).toEqual(['sigue funcionando']);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('el fichero temporal es propio de cada proceso (un <fichero>.tmp ajeno no rompe el guardado)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-lock-'));
    const store = new MemoryStore(dir);
    const file = store.fileFor('s');
    // Lo que deja otro proceso a medio escribir en el nombre compartido de antes.
    mkdirSync(`${file}.tmp`);
    store.remember('s', 'guardado');
    expect(readFileSync(file, 'utf8')).toContain('guardado');
  });
});

describe('forget de una corrección', () => {
  it('olvidar la corrección vuelve a hacer vigente el hecho que corregía', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-forget-'));
    const store = new MemoryStore(dir);
    const old = store.remember('s', 'vivo en Madrid');
    const fix = store.supersede('s', old.id, 'vivo en Valencia');
    expect(store.recall('s', 'vivo').map((e) => e.text)).toEqual(['vivo en Valencia']);
    expect(store.forget('s', fix.id)).toBe(true);
    const back = store.get('s', old.id);
    expect(back?.supersededBy).toBeNull();
    expect(store.recall('s', 'vivo').map((e) => e.text)).toEqual(['vivo en Madrid']);
  });

  it('forgetMatching tampoco deja punteros colgando', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mem-forget-'));
    const store = new MemoryStore(dir);
    const old = store.remember('s', 'trabajo en Acme');
    const fix = store.supersede('s', old.id, 'trabajo en Globex');
    expect(store.forgetMatching('s', 'acme')).toEqual([old.id]);
    expect(store.get('s', fix.id)?.supersedes).toEqual([]);
    expect(store.forgetMatching('s', 'globex')).toEqual([fix.id]);
    expect(store.all('s')).toEqual([]);
  });
});
