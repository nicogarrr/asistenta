import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A trailing slash («node_modules/») only matches directories, so a node_modules
// SYMLINK (worktrees often use one) could be committed by accident (#616).
describe('.gitignore', () => {
  it('ignores node_modules even when it is a symlink', () => {
    const lines = readFileSync('.gitignore', 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim());
    expect(lines.some((l) => l === 'node_modules' || l === '/node_modules')).toBe(true);
  });
});
