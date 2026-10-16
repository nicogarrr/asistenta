import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it as baseIt, beforeEach, expect, vi } from 'vitest';
import { withPortableVaultLock } from '../src/vault-file-lock.js';

const it = process.platform === 'linux' ? baseIt : baseIt.skip;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-vault-lock-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
it('serializes two cooperating operations on the effective same file', async () => {
  const file = join(dir, 'secrets.json');
  let active = 0;
  let maximum = 0;
  const operation = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
  };
  await Promise.all([
    withPortableVaultLock(file, operation),
    withPortableVaultLock(file, operation),
  ]);
  expect(maximum).toBe(1);
});
it('does not serialize different effective files unnecessarily', async () => {
  let active = 0;
  let maximum = 0;
  const operation = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((r) => setTimeout(r, 50));
    active--;
  };
  await Promise.all([
    withPortableVaultLock(join(dir, 'one.json'), operation),
    withPortableVaultLock(join(dir, 'two.json'), operation),
  ]);
  expect(maximum).toBe(2);
});
it('rejects open directory without changing permissions or running the writer', async () => {
  chmodSync(dir, 0o755);
  const op = vi.fn(async () => {});
  await expect(withPortableVaultLock(join(dir, 'secret.json'), op)).rejects.toThrow('privado');
  expect(op).not.toHaveBeenCalled();
});
it.each(['symlink', 'hardlink', 'open'] as const)(
  'rejects %s secret files before writing',
  async (kind) => {
    const original = join(dir, 'original');
    writeFileSync(original, 'synthetic', { mode: 0o600 });
    const file = join(dir, 'secrets.json');
    if (kind === 'symlink') symlinkSync(original, file);
    else if (kind === 'hardlink') linkSync(original, file);
    else writeFileSync(file, 'synthetic', { mode: 0o644 });
    const op = vi.fn(async () => {});
    await expect(withPortableVaultLock(file, op)).rejects.toThrow();
    expect(op).not.toHaveBeenCalled();
    expect(readFileSync(original, 'utf8')).toBe('synthetic');
  },
);
it('rejects a symlinked parent or lock rather than following it', async () => {
  const parent = join(dir, 'alias');
  symlinkSync(dir, parent);
  const op = vi.fn(async () => {});
  await expect(withPortableVaultLock(join(parent, 'secrets.json'), op)).rejects.toThrow('enlaces');
  const target = join(dir, 'innocent');
  writeFileSync(target, 'untouched', { mode: 0o600 });
  symlinkSync(target, join(dir, 'secrets.json.writer.lock'));
  await expect(withPortableVaultLock(join(dir, 'secrets.json'), op)).rejects.toThrow();
  expect(op).not.toHaveBeenCalled();
  expect(readFileSync(target, 'utf8')).toBe('untouched');
});
