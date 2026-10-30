import { describe, expect, it } from 'vitest';
import { checkPatch, isProtectedPath } from '../src/evolve/guard.js';
import { touchesForbidden } from '../src/evolve/score.js';

// Decisión de Nico (30 oct): ningún intento puede tocar el control del propio bucle.
const CONTROL = [
  'src/evolve/loop.ts',
  'src/evolve/score.ts',
  'src/evolve/worktree.ts',
  'src/evolve/measure.ts',
  'src/evolve/run.ts',
  'src/evolve/receipt.ts',
  'src/evolve/archive.ts',
  'src/evolve/guard.ts',
  'src/evolve/battery-judge.ts',
];
const diffOf = (a: string, b = a) =>
  `diff --git ${a} ${b}\nindex 1..2 100644\n--- ${a}\n+++ ${b}\n@@ -1 +1 @@\n-x\n+y\n`;

describe('evolve guard: el control del bucle es intocable', () => {
  it('cada fichero de control es ruta protegida', () => {
    for (const f of CONTROL) {
      expect(isProtectedPath(f), f).toBe(true);
      expect(checkPatch(diffOf(`a/${f}`, `b/${f}`))).toContainEqual({
        file: f,
        rule: 'ruta protegida',
      });
    }
    expect(touchesForbidden(CONTROL)).toEqual(CONTROL);
  });

  it('otra grafía del mismo fichero (mayúsculas, barra invertida) también se veta', () => {
    for (const f of [
      'src/Evolve/Loop.ts',
      'SRC/EVOLVE/score.ts',
      'src\\evolve\\worktree.ts',
      'Src/evolve/Measure.ts',
    ]) {
      expect(isProtectedPath(f), f).toBe(true);
    }
    expect(touchesForbidden(['src/Evolve/guard.ts', 'docs/notas.md'])).toEqual([
      'src/Evolve/guard.ts',
    ]);
  });

  it('entrecomillado por git (acento, barra invertida) y en otra grafía también se veta', () => {
    const d = diffOf('"a/src/Evolve/M\\303\\251tricas.ts"', '"b/src\\\\evolve\\\\Score.ts"');
    const files = checkPatch(d).map((v) => v.file);
    expect(files).toEqual(expect.arrayContaining(['src\\evolve\\Score.ts']));
    expect(files.some((f) => f === 'src/Evolve/Métricas.ts')).toBe(true);
  });

  it('lo normal sigue sin vetarse', () => {
    for (const f of ['src/tools/web.ts', 'docs/evolve.md', 'src/evolveish.ts']) {
      expect(isProtectedPath(f), f).toBe(false);
    }
  });
});
