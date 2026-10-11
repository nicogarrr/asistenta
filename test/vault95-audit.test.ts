import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'PA_VAULT_BACKEND',
  'PA_SECRETS_FILE',
  'PA_SECRET_MAIL_ADDRESS',
  'PA_SECRET_MAIL_PASSWORD',
];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.doUnmock('node:fs');
});

it('mail env-only override remains readable after rejected file ownership', async () => {
  vi.resetModules();
  process.env.PA_VAULT_BACKEND = 'portable';
  process.env.PA_SECRETS_FILE = join(mkdtempSync(join(tmpdir(), 'vault95-')), 'secrets.json');
  process.env.PA_SECRET_MAIL_ADDRESS = 'env@example.invalid';
  const { vaultSet, vaultGet, clearVaultCache } = await import('../src/vault.js');
  await vaultSet('mail:address', 'written@example.invalid');
  expect(await vaultGet('mail:address')).toBe('env@example.invalid');
  clearVaultCache();
  expect(await vaultGet('mail:address')).toBe('env@example.invalid');
});

it('env wins for a setMany pair, with and without prior file, after cache clear', async () => {
  vi.resetModules();
  process.env.PA_VAULT_BACKEND = 'portable';
  process.env.PA_SECRETS_FILE = join(mkdtempSync(join(tmpdir(), 'vault95b-')), 'secrets.json');
  const { vaultSetMany, vaultGet, clearVaultCache } = await import('../src/vault.js');
  // Sin fichero previo: solo password con override env.
  process.env.PA_SECRET_MAIL_PASSWORD = 'envpassenvpass12';
  await vaultSetMany({
    'mail:address': 'disk@example.invalid',
    'mail:password': 'writtenwritten12',
  });
  expect(await vaultGet('mail:address')).toBe('disk@example.invalid');
  expect(await vaultGet('mail:password')).toBe('envpassenvpass12');
  clearVaultCache();
  expect(await vaultGet('mail:password')).toBe('envpassenvpass12');
  // Con override en address tambien: la pareja entera se resuelve por env.
  process.env.PA_SECRET_MAIL_ADDRESS = 'env@example.invalid';
  await vaultSetMany({
    'mail:address': 'other@example.invalid',
    'mail:password': 'writtentwo2222',
  });
  clearVaultCache();
  expect(await vaultGet('mail:address')).toBe('env@example.invalid');
  expect(await vaultGet('mail:password')).toBe('envpassenvpass12');
});
