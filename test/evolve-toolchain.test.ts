import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolchainFingerprint } from '../src/evolve/toolchain.js';

// El proponente es un programa del mismo usuario: en un Node instalado por el usuario (nvm en
// Linux/mac) puede escribir el npmrc propio de npm, el global (<prefijo>/etc/npmrc) o poner
// un `npx` antes en el PATH. Un node-options en el npmrc de npm cargaba código en el
// `npx vitest` de la medición (comprobado con npm real en una copia de Node, 31 oct).
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeNode(win = false) {
  const base = mkdtempSync(join(tmpdir(), 'evo-toolchain-'));
  dirs.push(base);
  const prefix = join(base, 'node');
  const bin = win ? prefix : join(prefix, 'bin');
  const npm = win
    ? join(prefix, 'node_modules', 'npm')
    : join(prefix, 'lib', 'node_modules', 'npm');
  const early = join(base, 'early');
  mkdirSync(join(npm, 'lib'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(early);
  const execPath = join(bin, win ? 'node.exe' : 'node');
  writeFileSync(execPath, 'bin');
  writeFileSync(join(npm, 'package.json'), '{"name":"npm"}');
  writeFileSync(join(npm, 'lib', 'cli.js'), '// npm');
  const sep = win ? ';' : ':';
  const opts = {
    execPath,
    pathEnv: `${early}${sep}${bin}`,
    platform: (win ? 'win32' : 'linux') as NodeJS.Platform,
  };
  return { prefix, npm, early, opts, fp: () => toolchainFingerprint(opts) };
}

describe('la huella de Node y npm fuera de la copia', () => {
  it('no cambia si nadie toca nada', () => {
    const t = fakeNode();
    expect(t.fp()).toBe(t.fp());
  });
  it('un node-options en el npmrc propio de npm cambia la huella', () => {
    const t = fakeNode();
    const before = t.fp();
    writeFileSync(join(t.npm, 'npmrc'), 'node-options=--require /tmp/x.cjs\n');
    expect(t.fp()).not.toBe(before);
  });
  it('la config global <prefijo>/etc/npmrc cambia la huella', () => {
    const t = fakeNode();
    const before = t.fp();
    mkdirSync(join(t.prefix, 'etc'));
    writeFileSync(join(t.prefix, 'etc', 'npmrc'), 'node-options=--require /tmp/x.cjs\n');
    expect(t.fp()).not.toBe(before);
  });
  it('cambiar el código de npm cambia la huella', () => {
    const t = fakeNode();
    const before = t.fp();
    writeFileSync(join(t.npm, 'lib', 'cli.js'), '// npm cambiado');
    expect(t.fp()).not.toBe(before);
  });
  it('un npx puesto antes en el PATH cambia la huella', () => {
    const t = fakeNode();
    const before = t.fp();
    writeFileSync(join(t.early, 'npx'), '#!/bin/sh\necho fake');
    expect(t.fp()).not.toBe(before);
  });
  it('en Windows mira node_modules\\npm junto a node.exe y npx.cmd en el PATH', () => {
    const t = fakeNode(true);
    const before = t.fp();
    writeFileSync(join(t.npm, 'npmrc'), 'node-options=--require x\n');
    const mid = t.fp();
    expect(mid).not.toBe(before);
    writeFileSync(join(t.early, 'npx.cmd'), '@echo fake');
    expect(t.fp()).not.toBe(mid);
  });
});

describe('el shell que usa npx también cuenta', () => {
  it('un sh puesto antes en el PATH cambia la huella', () => {
    const t = fakeNode();
    const before = t.fp();
    writeFileSync(join(t.early, 'sh'), '#!/bin/bash\nexec /bin/sh "$@"');
    expect(t.fp()).not.toBe(before);
  });
  it('en Windows, un cmd.exe puesto antes en el PATH cambia la huella', () => {
    const t = fakeNode(true);
    const before = t.fp();
    writeFileSync(join(t.early, 'cmd.exe'), 'MZ');
    expect(t.fp()).not.toBe(before);
  });
});

describe('el git con el que el bucle se comprueba también cuenta', () => {
  it('un git puesto antes en el PATH cambia la huella', () => {
    const t = fakeNode();
    const before = t.fp();
    writeFileSync(
      join(t.early, 'git'),
      '#!/bin/sh\n[ "$1" = status ] && exit 0\nexec /usr/bin/git "$@"',
    );
    expect(t.fp()).not.toBe(before);
  });
  it('en Windows, un git.exe o git.cmd puesto antes en el PATH cambia la huella', () => {
    for (const name of ['git.exe', 'git.cmd']) {
      const t = fakeNode(true);
      const before = t.fp();
      writeFileSync(join(t.early, name), 'MZ');
      expect(t.fp()).not.toBe(before);
    }
  });
});

describe('las herramientas que buscan y matan los procesos del intento también cuentan', () => {
  it('un ps o un lsof puesto antes en el PATH cambia la huella', () => {
    for (const name of ['ps', 'lsof']) {
      const t = fakeNode();
      const before = t.fp();
      writeFileSync(join(t.early, name), '#!/bin/sh\nexit 0');
      expect(t.fp()).not.toBe(before);
    }
  });
  it('en Windows, un powershell.exe, taskkill.exe o netstat.exe puesto antes en el PATH cambia la huella', () => {
    for (const name of ['powershell.exe', 'taskkill.exe', 'netstat.exe']) {
      const t = fakeNode(true);
      const before = t.fp();
      writeFileSync(join(t.early, name), 'MZ');
      expect(t.fp()).not.toBe(before);
    }
  });
});
