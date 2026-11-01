import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkPatch } from '../src/evolve/guard.js';
import { diffText } from '../src/evolve/worktree.js';

// Un byte NUL en un comentario no impide que el código corra, pero git trata el fichero como
// binario y el diff solo dice «Binary files … differ»: las reglas de contenido no ven nada.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  });

function attempt(after: string): string {
  const root = mkdtempSync(join(tmpdir(), 'evo-bin-'));
  dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'tool.ts'), 'export function borrar() {\n  requireApproval();\n}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  git(root, 'checkout', '-qb', 'intento');
  writeFileSync(join(root, 'tool.ts'), after);
  git(root, 'commit', '-qam', 'intento');
  return diffText(root, 'main', 'intento');
}

describe('el guard no deja pasar un parche que git no enseña', () => {
  it('quitar una aprobación escondido tras un NUL en un comentario se veta', () => {
    const patch = attempt('// \u0000\nexport function borrar() {}\n');
    expect(patch).toMatch(/^Binary files /m);
    const v = checkPatch(patch);
    expect(v.some((x) => x.rule.includes('binario'))).toBe(true);
  });

  it('el mismo cambio en texto normal ya se veía y se sigue viendo', () => {
    const v = checkPatch(attempt('export function borrar() {}\n'));
    expect(v.some((x) => x.rule.includes('aprobacion'))).toBe(true);
    expect(v.some((x) => x.rule.includes('binario'))).toBe(false);
  });
});
