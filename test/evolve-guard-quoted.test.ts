import { describe, expect, it } from 'vitest';
import { changedFiles, checkPatch, unquoteGitPath } from '../src/evolve/guard.js';

// git entrecomilla (core.quotePath) los nombres con no ASCII, comillas, barras o control.
const quoted = (a: string, b: string, body = '') =>
  `diff --git "a/${a}" "b/${b}"\nindex 1..2 100644\n--- "a/${a}"\n+++ "b/${b}"\n@@ -1 +1 @@\n-x\n+y\n${body}`;

describe('evolve guard: nombres que git entrecomilla', () => {
  it('deshace el entrecomillado de git', () => {
    expect(unquoteGitPath('"evolve/bater\\303\\255a.json"')).toBe('evolve/batería.json');
    expect(unquoteGitPath('"a\\"b\\\\c\\td"')).toBe('a"b\\c\td');
    expect(unquoteGitPath('sin/comillas')).toBe('sin/comillas');
  });

  it('una ruta protegida con acento no se escapa del veto', () => {
    const d = quoted('evolve/bater\\303\\255a.json', 'evolve/bater\\303\\255a.json');
    expect(changedFiles(d)).toContain('evolve/batería.json');
    expect(checkPatch(d)).toContainEqual({ file: 'evolve/batería.json', rule: 'ruta protegida' });
  });

  it('una ruta protegida con comillas o barra invertida no se escapa', () => {
    const d = quoted('src/evolve/battery\\"x.ts', 'src/evolve/battery\\\\y.ts');
    expect(checkPatch(d).map((v) => v.file)).toEqual(
      expect.arrayContaining(['src/evolve/battery"x.ts', 'src/evolve/battery\\y.ts']),
    );
  });

  it('un solo lado entrecomillado (renombrado) también cuenta', () => {
    const d =
      'diff --git a/docs/x.md "b/deploy/caf\\303\\251.sh"\nsimilarity index 100%\nrename from docs/x.md\nrename to "deploy/caf\\303\\251.sh"\n';
    expect(changedFiles(d)).toEqual(expect.arrayContaining(['docs/x.md', 'deploy/café.sh']));
    expect(checkPatch(d)).toContainEqual({ file: 'deploy/café.sh', rule: 'ruta protegida' });
  });

  it('borrar un test con nombre entrecomillado es «borra tests»', () => {
    const d =
      'diff --git "a/test/caf\\303\\251.test.ts" "b/test/caf\\303\\251.test.ts"\ndeleted file mode 100644\n--- "a/test/caf\\303\\251.test.ts"\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n';
    expect(checkPatch(d)).toContainEqual({ file: 'test/', rule: 'borra tests' });
  });

  it('las líneas del cuerpo no se leen como cabeceras', () => {
    const d =
      'diff --git a/docs/x.md b/docs/x.md\n--- a/docs/x.md\n+++ b/docs/x.md\n@@ -1 +1 @@\n--- a/deploy/y\n++++ b/deploy/z\n';
    expect(changedFiles(d)).toEqual(['docs/x.md']);
  });
});
