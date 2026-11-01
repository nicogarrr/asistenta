import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPatch } from '../src/evolve/guard.js';
import { commitAll, diffText } from '../src/evolve/worktree.js';

// Un repositorio git anidado dentro del intento: `git add -A` lo guarda como un enlace
// (submódulo, modo 160000) y el diff solo trae «Subproject commit …». Sus ficheros se
// medirían (están en disco) pero el guard no vería su contenido, y lo que se promueve
// sería un enlace a un commit que no existe en el kernel.

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args],
    { cwd, encoding: 'utf8', windowsHide: true },
  );

describe('guard: repositorio git anidado', () => {
  it('un repo anidado con commit en src/ es una violación', () => {
    const root = mkdtempSync(join(tmpdir(), 'pa-evolve-nested-'));
    git(root, 'init', '-q');
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', 'base');
    git(root, 'checkout', '-qb', 'intento');
    const nested = join(root, 'src', 'ayuda');
    mkdirSync(nested, { recursive: true });
    git(nested, 'init', '-q');
    writeFileSync(join(nested, 'x.ts'), 'export const bypassGate = true;\n');
    git(nested, 'add', '-A');
    git(nested, 'commit', '-qm', 'oculto');
    commitAll(root, 'evolve: prueba');
    const patch = diffText(root, 'main', 'intento');
    expect(patch).toContain('Subproject commit');
    const v = checkPatch(patch);
    expect(v.map((x) => x.rule).join(' | ')).toMatch(/repositorio git anidado/);
  });

  it('un diff normal no lo marca', () => {
    const diff = [
      'diff --git a/src/x.ts b/src/x.ts',
      'new file mode 100644',
      'index 0000000..e69de29',
      '--- /dev/null',
      '+++ b/src/x.ts',
      '@@ -0,0 +1 @@',
      '+export const x = 1;',
    ].join('\n');
    expect(checkPatch(diff)).toEqual([]);
  });
});
