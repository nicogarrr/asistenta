import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTool, readTool, writeTool } from '../src/tools/fs.js';

/**
 * La comprobación de contención solo miraba la ruta escrita. Un enlace simbólico (o
 * unión en Windows) dentro del directorio de trabajo llevaba la lectura o la escritura
 * fuera. Misma regla que #1005: también cuenta la ruta real en disco.
 */
const WIN = process.platform === 'win32';
const DIR = WIN ? 'junction' : 'dir';
let work = '';
let outside = '';
let cwd = '';

beforeEach(() => {
  cwd = process.cwd();
  work = mkdtempSync(join(tmpdir(), 'fsl-work-'));
  outside = mkdtempSync(join(tmpdir(), 'fsl-out-'));
  writeFileSync(join(outside, 'privado.txt'), 'secreto');
  mkdirSync(join(work, 'dentro'));
  writeFileSync(join(work, 'dentro', 'a.txt'), 'a');
  symlinkSync(outside, join(work, 'enlace'), DIR);
  // Un enlace a fichero en Windows pide privilegios: ahí solo se prueban uniones.
  if (!WIN) symlinkSync(join(outside, 'privado.txt'), join(work, 'fichero'));
  symlinkSync(join(work, 'dentro'), join(work, 'atajo'), DIR);
  process.chdir(work);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(work, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const ESC = /escapes the working directory/;

describe('fs: un enlace dentro del cwd no saca la ruta fuera', () => {
  it('write por un directorio enlazado fuera se deniega', async () => {
    await expect(
      writeTool.execute('id', { path: 'enlace/nuevo.txt', content: 'x' } as never),
    ).rejects.toThrow(ESC);
    expect(existsSync(join(outside, 'nuevo.txt'))).toBe(false);
  });

  it.skipIf(WIN)('write sobre un fichero enlazado fuera se deniega', async () => {
    await expect(
      writeTool.execute('id', { path: 'fichero', content: 'x' } as never),
    ).rejects.toThrow(ESC);
  });

  it('read y list por el enlace se deniegan', async () => {
    await expect(readTool.execute('id', { path: 'enlace/privado.txt' } as never)).rejects.toThrow(
      ESC,
    );
    if (!WIN) {
      await expect(readTool.execute('id', { path: 'fichero' } as never)).rejects.toThrow(ESC);
    }
    await expect(listTool.execute('id', { path: 'enlace' } as never)).rejects.toThrow(ESC);
  });

  it('un enlace que se queda dentro sigue funcionando', async () => {
    await writeTool.execute('id', { path: 'atajo/b.txt', content: 'b' } as never);
    expect(existsSync(join(work, 'dentro', 'b.txt'))).toBe(true);
    await expect(readTool.execute('id', { path: 'atajo/a.txt' } as never)).resolves.toBeTruthy();
  });
});
