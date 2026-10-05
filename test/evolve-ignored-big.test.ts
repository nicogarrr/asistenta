import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ignoredFiles } from '../src/evolve/worktree.js';

describe('ignoredFiles', () => {
  it('no revienta con mas de 1 MB de salida de git (copia de node_modules)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ign-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\nsecreto.txt\n');
      const deep = join(dir, 'node_modules', ...Array.from({ length: 12 }, () => 'd'.repeat(200)));
      mkdirSync(deep, { recursive: true });
      for (let i = 0; i < 500; i++)
        writeFileSync(join(deep, String(i).padStart(4, '0') + 'x'.repeat(200)), '');
      writeFileSync(join(dir, 'secreto.txt'), 'x');
      expect(ignoredFiles(dir)).toEqual(['secreto.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
