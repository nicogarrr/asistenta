import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTool, writeTool } from '../src/tools/fs.js';

let work = '';
let outside = '';
let cwd = '';
const text = (r: unknown): string => JSON.stringify((r as { content?: unknown }).content ?? r);

beforeEach(() => {
  cwd = process.cwd();
  work = mkdtempSync(join(tmpdir(), 'fsdots-work-'));
  outside = mkdtempSync(join(tmpdir(), 'fsdots-out-'));
  process.chdir(work);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(work, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('ficheros que empiezan por «..» dentro del cwd (bugs13)', () => {
  it('se leen y se escriben: antes se rechazaban como si salieran del directorio', async () => {
    writeFileSync(join(work, '..notas.txt'), 'hola');
    expect(text(await readTool.execute('id', { path: '..notas.txt' } as never))).toContain('hola');
    mkdirSync(join(work, '...viejo'));
    await writeTool.execute('id', { path: '...viejo/a.txt', content: 'x' } as never);
    expect(existsSync(join(work, '...viejo', 'a.txt'))).toBe(true);
  });

  it('salir del directorio sigue prohibido', async () => {
    const name = outside.split(sep).pop() as string;
    writeFileSync(join(outside, 's.txt'), 'secreto');
    for (const path of [
      '..',
      `../${name}/s.txt`,
      `sub/../../${name}/s.txt`,
      join(outside, 's.txt'),
    ]) {
      await expect(readTool.execute('id', { path } as never)).rejects.toThrow(
        /escapes the working directory/,
      );
    }
    await expect(
      writeTool.execute('id', { path: `../${name}/w.txt`, content: 'x' } as never),
    ).rejects.toThrow(/escapes the working directory/);
    expect(existsSync(join(outside, 'w.txt'))).toBe(false);
  });
});
