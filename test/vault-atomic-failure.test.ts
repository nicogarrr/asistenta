import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it as baseIt, expect, vi } from 'vitest';

const fault = vi.hoisted(() => ({ file: '', enabled: false }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    renameSync: (
      source: Parameters<typeof fs.renameSync>[0],
      destination: Parameters<typeof fs.renameSync>[1],
    ) => {
      if (fault.enabled && String(destination) === fault.file)
        throw new Error('synthetic rename failure');
      return fs.renameSync(source, destination);
    },
  };
});

import { clearVaultCache, vaultSetMany } from '../src/vault.js';

const it = process.platform === 'linux' ? baseIt : baseIt.skip;
it('keeps the previous file intact and removes its own temporary when atomic commit fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-vault-commit-'));
  const old = { ...process.env };
  const file = join(dir, 'secrets.json');
  writeFileSync(file, JSON.stringify({ 'existing:key': 'synthetic-old' }), { mode: 0o600 });
  writeFileSync(`${file}.tmp`, 'unrelated-sentinel', { mode: 0o600 });
  process.env.PA_VAULT_BACKEND = 'portable';
  process.env.PA_SECRETS_FILE = file;
  clearVaultCache();
  fault.file = file;
  fault.enabled = true;
  try {
    await expect(vaultSetMany({ 'new:key': 'synthetic-new' })).rejects.toThrow('rename failure');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'existing:key': 'synthetic-old' });
    expect(readFileSync(`${file}.tmp`, 'utf8')).toBe('unrelated-sentinel');
    expect(readdirSync(dir).sort()).toEqual([
      'secrets.json',
      'secrets.json.tmp',
      'secrets.json.writer.lock',
    ]);
  } finally {
    fault.enabled = false;
    for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k];
    Object.assign(process.env, old);
    clearVaultCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
