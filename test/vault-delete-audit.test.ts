import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const ENV_KEYS = ['PA_VAULT_BACKEND', 'PA_SECRETS_FILE', 'PA_SECRET_PROVIDER_APIKEY'];

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.doUnmock('node:fs');
});

it('delete is durable after clearing cache', async () => {
  vi.resetModules();
  process.env.PA_VAULT_BACKEND = 'portable';
  process.env.PA_SECRETS_FILE = join(mkdtempSync(join(tmpdir(), 'vault-del-')), 'secrets.json');
  const { vaultSet, vaultDelete, vaultGet, clearVaultCache } = await import('../src/vault.js');
  await vaultSet('audit:deletable', 'fake');
  expect(await vaultDelete('audit:deletable')).toBe(true);
  clearVaultCache();
  expect(await vaultGet('audit:deletable')).toBeUndefined();
});

it('env override owns the key: written value never reaches cache nor file', async () => {
  vi.resetModules();
  const dir = mkdtempSync(join(tmpdir(), 'vault-env-'));
  process.env.PA_VAULT_BACKEND = 'portable';
  process.env.PA_SECRETS_FILE = join(dir, 'secrets.json');
  process.env.PA_SECRET_PROVIDER_APIKEY = 'from-env';
  const { vaultSet, vaultGet, clearVaultCache } = await import('../src/vault.js');
  await vaultSet('provider:apiKey', 'written-value');
  expect(await vaultGet('provider:apiKey')).toBe('from-env');
  expect(readFileSync(process.env.PA_SECRETS_FILE, 'utf8')).not.toContain('written-value');
  clearVaultCache();
  expect(await vaultGet('provider:apiKey')).toBe('from-env');
});
