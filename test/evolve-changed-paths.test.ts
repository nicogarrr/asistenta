import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkPatch } from '../src/evolve/guard.js';
import { touchesForbidden } from '../src/evolve/score.js';
import { changedFiles, diffText } from '../src/evolve/worktree.js';

// El veto de rutas del bucle leía nombres que git entrecomilla (tildes) y renombrados que
// ocultaban un test borrado.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const g = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
    cwd,
    encoding: 'utf8',
  });
const put = (root: string, f: string, body: string) => {
  mkdirSync(dirname(join(root, f)), { recursive: true });
  writeFileSync(join(root, f), body);
};
function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'pa-evolve-paths-'));
  dirs.push(d);
  g(d, 'init', '-q', '-b', 'main');
  put(
    d,
    'test/caso.test.ts',
    `import { it } from 'vitest';\nit('x', () => {});\n${'// relleno\n'.repeat(20)}`,
  );
  put(d, 'src/a.ts', 'export const a = 1;\n');
  g(d, 'add', '-A');
  g(d, 'commit', '-qm', 'base');
  g(d, 'checkout', '-qb', 'intento');
  return d;
}
const commit = (d: string) => {
  g(d, 'add', '-A');
  g(d, 'commit', '-qm', 'intento');
};

describe('rutas del intento tal cual las ve el veto', () => {
  it('una ruta protegida con tilde se veta', () => {
    const d = repo();
    put(d, '.github/workflows/ñ.yml', 'on: push\n');
    commit(d);
    const files = changedFiles(d, 'main', 'intento');
    expect(files).toEqual(['.github/workflows/ñ.yml']);
    expect(touchesForbidden(files)).toHaveLength(1);
    expect(
      checkPatch(diffText(d, 'main', 'intento')).some((v) => v.rule === 'ruta protegida'),
    ).toBe(true);
  });

  it('renombrar un test para que no corra cuenta como borrarlo', () => {
    const d = repo();
    renameSync(join(d, 'test/caso.test.ts'), join(d, 'src/caso.txt'));
    commit(d);
    expect(changedFiles(d, 'main', 'intento').sort()).toEqual([
      'src/caso.txt',
      'test/caso.test.ts',
    ]);
    expect(checkPatch(diffText(d, 'main', 'intento')).some((v) => v.rule === 'borra tests')).toBe(
      true,
    );
  });
});
