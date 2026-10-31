import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gitControlFingerprint } from '../src/evolve/worktree.js';

// El proponente es un programa del mismo usuario: puede escribir su ~/.gitconfig. Un
// core.fsmonitor ahí hace que `git status` del kernel diga «limpio» aunque haya cambiado
// (comprobado con git real), así que esa config cuenta igual que la del repo.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'evo-gitglobal-'));
  dirs.push(base);
  const root = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(root);
  mkdirSync(home);
  execFileSync('git', ['init', '-q'], { cwd: root });
  return { root, home };
}

describe('la config global de git también se vigila', () => {
  it('un fsmonitor plantado en ~/.gitconfig cambia la huella', () => {
    const { root, home } = setup();
    const before = gitControlFingerprint(root, home);
    writeFileSync(join(home, '.gitconfig'), '[core]\n\tfsmonitor = /tmp/evil.sh\n');
    expect(gitControlFingerprint(root, home)).not.toBe(before);
  });

  it('también ~/.config/git/config y su fichero de atributos', () => {
    const { root, home } = setup();
    const saved = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const before = gitControlFingerprint(root, home);
      mkdirSync(join(home, '.config', 'git'), { recursive: true });
      writeFileSync(join(home, '.config', 'git', 'attributes'), '* -diff\n');
      const mid = gitControlFingerprint(root, home);
      expect(mid).not.toBe(before);
      writeFileSync(join(home, '.config', 'git', 'config'), '[core]\n\thooksPath = /tmp/h\n');
      expect(gitControlFingerprint(root, home)).not.toBe(mid);
    } finally {
      if (saved !== undefined) process.env.XDG_CONFIG_HOME = saved;
    }
  });

  it('sin cambios, la misma huella', () => {
    const { root, home } = setup();
    expect(gitControlFingerprint(root, home)).toBe(gitControlFingerprint(root, home));
  });
});
