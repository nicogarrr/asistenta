/**
 * Auto-mejora: «✅ Aplicar» abre una PR en GitHub cuando el PC tiene `gh` con sesión.
 * Antes el parche entraba siempre como un commit local en la copia instalada, y la
 * actualización automática (solo avance rápido) se quedaba parada hasta que Nico hiciera
 * git push o lo deshiciera. Ahora va a una rama `auto-mejora/<id>` con su PR y la copia
 * instalada no se toca; sin `gh` (o si la subida falla) sigue el commit local de siempre.
 * git de verdad con un remoto local; `gh` simulado.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyCandidate,
  findCandidate,
  type GitRunner,
  gitIn,
  reviewCard,
} from '../src/evolve/review.js';

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function setup(withRemote = true) {
  const root = mkdtempSync(join(tmpdir(), 'evo-pr-'));
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const state = join(root, 'state');
  mkdirSync(repo);
  mkdirSync(join(state, 'evolve'), { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@t');
  sh(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, 'saludo.ts'), "export const hola = 'hola';\n");
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'base');
  if (withRemote) {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    sh(repo, 'remote', 'add', 'origin', remote);
    sh(repo, 'push', '-q', 'origin', 'main');
  }
  writeFileSync(join(repo, 'saludo.ts'), "export const hola = '¡hola!';\n");
  const patch = sh(repo, 'diff');
  sh(repo, 'checkout', '-q', '--', 'saludo.ts');
  const patchFile = join(state, 'evolve', 'promovido-w45-a1.patch');
  writeFileSync(patchFile, patch);
  writeFileSync(
    join(state, 'evolve', 'promovido-w45-a1.json'),
    JSON.stringify({ hypothesis: 'saludar con exclamación', branch: 'evolve/w45-a1' }),
  );
  writeFileSync(join(state, 'evolve', 'promovido-w45-a1.receipt.md'), '- [x] tests verdes\n');
  const c = findCandidate(state, 'w45-a1') as NonNullable<ReturnType<typeof findCandidate>>;
  return { repo, remote, state, patchFile, c };
}

function fakeGh(authed: boolean, prOut = 'https://github.com/nico/asistenta/pull/77\n') {
  const calls: string[][] = [];
  const gh: GitRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'auth')
      return authed ? { code: 0, out: 'Logged in' } : { code: 1, out: 'not logged in' };
    if (args[0] === 'pr') return { code: 0, out: prOut };
    return { code: 1, out: '?' };
  };
  return { gh, calls };
}

describe('auto-mejora: «✅ Aplicar» abre una PR si hay gh', () => {
  it('con gh con sesión: rama auto-mejora/<id> en GitHub + PR, y la copia instalada intacta', async () => {
    const { repo, remote, patchFile, c } = setup();
    const { gh, calls } = fakeGh(true);
    const r = await applyCandidate(c, gitIn(repo), gh);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('https://github.com/nico/asistenta/pull/77');
    expect(r.text).toContain('actualización automática');
    expect(r.text).not.toContain('git revert');
    // La copia instalada sigue en el commit de antes, sin cambios: la auto-actualización no se bloquea.
    expect(sh(repo, 'log', '-1', '--format=%s').trim()).toBe('base');
    expect(readFileSync(join(repo, 'saludo.ts'), 'utf8')).toBe("export const hola = 'hola';\n");
    expect(sh(repo, 'status', '--porcelain').trim()).toBe('');
    expect(sh(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    expect(sh(repo, 'branch', '--list', 'auto-mejora/*').trim()).toBe('');
    // En el remoto está la rama con el commit del parche.
    expect(sh(remote, 'log', '-1', '--format=%s', 'auto-mejora/w45-a1').trim()).toBe(
      'Auto-mejora: saludar con exclamación',
    );
    expect(sh(remote, 'show', 'auto-mejora/w45-a1:saludo.ts')).toContain('¡hola!');
    const pr = calls.find((a) => a[0] === 'pr') as string[];
    expect(pr.slice(0, 6)).toEqual([
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      'auto-mejora/w45-a1',
    ]);
    expect(pr[pr.indexOf('--body') + 1]).toContain('✅ tests verdes');
    // Ya no queda pendiente: un segundo toque no vuelve a subirlo.
    expect(existsSync(patchFile)).toBe(false);
    expect(findCandidate(join(patchFile, '..', '..'), 'w45-a1')).toBeUndefined();
  });

  it('sin sesión en gh: commit local como antes', async () => {
    const { repo, c } = setup();
    const { gh, calls } = fakeGh(false);
    const r = await applyCandidate(c, gitIn(repo), gh);
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Aplicado como commit [0-9a-f]{7,}/);
    expect(sh(repo, 'log', '-1', '--format=%s').trim()).toBe(
      'Auto-mejora: saludar con exclamación',
    );
    expect(calls.some((a) => a[0] === 'pr')).toBe(false);
  });

  it('si la subida falla (sin remoto), lo dice y deja el commit local sin restos', async () => {
    const { repo, c } = setup(false);
    const { gh, calls } = fakeGh(true);
    const r = await applyCandidate(c, gitIn(repo), gh);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('No pude subirlo a GitHub');
    expect(r.text).toMatch(/Aplicado como commit [0-9a-f]{7,}/);
    expect(sh(repo, 'log', '-1', '--format=%s').trim()).toBe(
      'Auto-mejora: saludar con exclamación',
    );
    expect(sh(repo, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    expect(sh(repo, 'branch', '--list', 'auto-mejora/*').trim()).toBe('');
    expect(calls.some((a) => a[0] === 'pr')).toBe(false);
  });

  it('si la rama sube pero gh no abre la PR, lo dice y no toca la copia', async () => {
    const { repo, remote, c } = setup();
    const { gh } = fakeGh(true, 'GraphQL: something failed');
    const r = await applyCandidate(c, gitIn(repo), gh);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('no pude abrir la PR');
    expect(r.text).toContain('auto-mejora/w45-a1');
    expect(sh(repo, 'log', '-1', '--format=%s').trim()).toBe('base');
    expect(sh(remote, 'branch', '--list', 'auto-mejora/*').trim()).toBe('auto-mejora/w45-a1');
  });

  it('la ficha avisa de que «Aplicar» abre una PR si hay gh', () => {
    const { c, patchFile } = setup();
    expect(reviewCard(c, readFileSync(patchFile, 'utf8'))).toContain('abre una PR en GitHub');
  });
});
