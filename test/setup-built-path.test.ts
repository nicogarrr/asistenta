import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { builtCliPath, setupCommand } from '../src/setup.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it('busca dist/cli.js junto a la instalación, no en la carpeta actual', () => {
  const repo = mkdtempSync(join(tmpdir(), 'pa-setup-built-'));
  dirs.push(repo);
  mkdirSync(join(repo, 'dist'));
  writeFileSync(join(repo, 'dist', 'cli.js'), '');
  const expected = join(repo, 'dist', 'cli.js');
  // Igual desde el código compilado (dist/setup.js) que desde src/setup.ts.
  expect(builtCliPath(pathToFileURL(join(repo, 'dist', 'setup.js')).href)).toBe(expected);
  expect(builtCliPath(pathToFileURL(join(repo, 'src', 'setup.ts')).href)).toBe(expected);
});

it('dice qué requisito falta', async () => {
  let out = '';
  const base = {
    write: (t: string) => {
      out += t;
    },
    platform: 'linux' as const,
    desktop: false,
    interactive: true,
    nodeMajor: 24,
    built: true,
    prerequisites: () => true,
  };
  expect(await setupCommand([], { ...base, built: false })).toBe(1);
  expect(out).toContain('Falta: dist/cli.js (ejecuta npm run build)');
  out = '';
  expect(await setupCommand([], { ...base, nodeMajor: 22 })).toBe(1);
  expect(out).toContain('Falta: Node 24 (tienes 22)');
  out = '';
  expect(await setupCommand([], { ...base, prerequisites: () => false })).toBe(1);
  expect(out).toContain('Falta: flock');
});
