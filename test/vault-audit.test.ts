import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it('failed durable save leaves old values in cache', async () => {
  vi.resetModules();
  const file = join(mkdtempSync(join(tmpdir(), 'vault-audit-')), 'secrets.json');
  process.env.PA_VAULT_BACKEND = 'portable';
  process.env.PA_SECRETS_FILE = file;
  writeFileSync(
    file,
    JSON.stringify({ 'mail:address': 'old@example.invalid', 'mail:password': 'oldfake' }),
    { mode: 0o600 },
  );
  vi.doMock('node:fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:fs')>()),
    renameSync: () => {
      throw new Error('mock disk failure');
    },
  }));
  const { vaultSetMany, vaultGet } = await import('../src/vault.js');
  await expect(
    vaultSetMany({ 'mail:address': 'new@example.invalid', 'mail:password': 'newfake' }),
  ).rejects.toThrow('mock disk failure');
  expect(await vaultGet('mail:address')).toBe('old@example.invalid');
  vi.doUnmock('node:fs');
});
