import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runWeek } from '../src/evolve/loop.js';
import type { Measurement } from '../src/evolve/score.js';

const m = (over: Partial<Measurement> = {}): Measurement => ({
  passed: 100,
  failed: 0,
  checks: 10,
  checksFailed: 0,
  durationMs: 1000,
  passingTests: ['t::a'],
  failingTests: [],
  ...over,
});

// El .git del intento es un fichero que apunta a su carpeta privada en el repo del kernel
// (HEAD, commondir…). Si el proponente lo cambia, el commit del intento (`git add -A` +
// commit, que se hace DESPUÉS de comprobar el kernel) cae en la rama del kernel sin pasar
// por el guard. Se comprueba leyendo el disco, antes de cualquier git en el intento.
describe('el proponente no puede redirigir el git de su intento', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      cwd,
      encoding: 'utf8',
    }).trim();

  function repo() {
    const root = mkdtempSync(join(tmpdir(), 'evo-g-'));
    const state = mkdtempSync(join(tmpdir(), 'evo-gs-'));
    dirs.push(root, state);
    git(root, 'init', '-q', '-b', 'main');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    return { root, state };
  }
  const run = (root: string, state: string, plant: (dir: string) => void) =>
    runWeek({
      root,
      stateDir: state,
      maxTries: 1,
      hypotheses: async () => ['idea'],
      propose: async (dir) => {
        plant(dir);
        writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
      },
      measure: async (o) =>
        o.cwd === root ? m() : m({ passed: 200, passingTests: ['t::a', 't::b'] }),
    });

  it('HEAD del intento apuntado a la rama del kernel: descarte y main intacta', async () => {
    const { root, state } = repo();
    const before = git(root, 'rev-parse', 'main');
    const report = await run(root, state, (dir) => {
      git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/main');
    });
    expect(git(root, 'rev-parse', 'main')).toBe(before);
    expect(report.promoted).toBe(false);
    expect(report.attempts[0]?.reason).toMatch(/git del intento/);
  });

  it('.git del intento apuntado al repo del kernel: descarte y main intacta', async () => {
    const { root, state } = repo();
    const before = git(root, 'rev-parse', 'main');
    const report = await run(root, state, (dir) => {
      writeFileSync(join(dir, '.git'), `gitdir: ${join(root, '.git')}\n`);
    });
    expect(git(root, 'rev-parse', 'main')).toBe(before);
    expect(report.promoted).toBe(false);
    expect(report.attempts[0]?.reason).toMatch(/git del intento/);
  });

  it('un commit propio del proponente en su rama sigue su camino', async () => {
    const { root, state } = repo();
    const report = await run(root, state, (dir) => {
      writeFileSync(join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'propio');
    });
    expect(report.attempts[0]?.reason ?? '').not.toMatch(/git del intento/);
  });
});
