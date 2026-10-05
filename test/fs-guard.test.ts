import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeTool } from '../src/tools/fs.js';

let work = '';
let outside = '';
let cwd = '';

beforeEach(() => {
  cwd = process.cwd();
  work = mkdtempSync(join(tmpdir(), 'fsg-work-'));
  outside = mkdtempSync(join(tmpdir(), 'fsg-out-'));
  process.chdir(work);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(work, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('write: contenido al directorio de trabajo (relevante para el aprobador QA)', () => {
  it('escribe dentro del cwd', async () => {
    await writeTool.execute('id', { path: 'pruebas/hola.txt', content: 'hola' } as never);
    expect(existsSync(join(work, 'pruebas', 'hola.txt'))).toBe(true);
  });

  it('deniega rutas fuera del cwd (absolutas y con ..)', async () => {
    const target = join(outside, 'x.txt');
    await expect(writeTool.execute('id', { path: target, content: 'x' } as never)).rejects.toThrow(
      /escapes the working directory/,
    );
    await expect(
      writeTool.execute('id', {
        path: `../${outside.split('/').pop()}/y.txt`,
        content: 'y',
      } as never),
    ).rejects.toThrow(/escapes the working directory/);
    expect(existsSync(target)).toBe(false);
  });
});
