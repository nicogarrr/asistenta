import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it as baseIt, beforeEach, expect, vi } from 'vitest';
import { clearVaultCache, configurePortableVault, vaultSet } from '../src/vault.js';

const it = process.platform === 'linux' ? baseIt : baseIt.skip;
let dir: string;
let old: NodeJS.ProcessEnv;
beforeEach(() => {
  old = { ...process.env };
  dir = mkdtempSync(join(tmpdir(), 'pa-configure-'));
  process.env.PA_VAULT_BACKEND = 'portable';
  process.env.PA_SECRETS_FILE = join(dir, 'secrets.json');
  clearVaultCache();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in old)) delete process.env[k];
  Object.assign(process.env, old);
  clearVaultCache();
  rmSync(dir, { recursive: true, force: true });
});
it('returns source metadata only and never copies environment-owned values into file', async () => {
  process.env.PA_SECRET_PROVIDER_APIKEY = 'synthetic-env';
  writeFileSync(
    process.env.PA_SECRETS_FILE as string,
    JSON.stringify({ 'telegram:botToken': 'synthetic-file' }),
    { mode: 0o600 },
  );
  const review = vi.fn(async (fields) => {
    expect(fields).toEqual([
      { key: 'provider:apiKey', source: 'environment' },
      { key: 'telegram:botToken', source: 'file' },
      { key: 'telegram:allowedUserIds', source: 'missing' },
    ]);
    expect(JSON.stringify(fields)).not.toContain('synthetic');
    return { 'telegram:allowedUserIds': '123' };
  });
  expect(
    await configurePortableVault(
      ['provider:apiKey', 'telegram:botToken', 'telegram:allowedUserIds'],
      review,
    ),
  ).toBe(true);
  expect(JSON.parse(readFileSync(process.env.PA_SECRETS_FILE as string, 'utf8'))).toEqual({
    'telegram:botToken': 'synthetic-file',
    'telegram:allowedUserIds': '123',
  });
});
it('cancel creates no secrets file and never commits proposed data', async () => {
  expect(await configurePortableVault(['key'], async () => undefined)).toBe(false);
  expect(existsSync(process.env.PA_SECRETS_FILE as string)).toBe(false);
});
it('aborts on an external writer changing the snapshot during review', async () => {
  const file = process.env.PA_SECRETS_FILE as string;
  writeFileSync(file, JSON.stringify({ existing: 'old' }), { mode: 0o600 });
  await expect(
    configurePortableVault(['new'], async () => {
      writeFileSync(file, JSON.stringify({ existing: 'external' }));
      return { new: 'proposal' };
    }),
  ).rejects.toThrow('cambió');
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ existing: 'external' });
});
it('aborts if the effective environment changes while collecting answers', async () => {
  await expect(
    configurePortableVault(['key'], async () => {
      process.env.PA_SECRET_KEY = 'env-override';
      return { key: 'proposal' };
    }),
  ).rejects.toThrow('cambió');
  expect(existsSync(process.env.PA_SECRETS_FILE as string)).toBe(false);
});
it('rejects replacing an environment-owned key', async () => {
  process.env.PA_SECRET_KEY = 'env-owned';
  await expect(configurePortableVault(['key'], async () => ({ key: 'proposal' }))).rejects.toThrow(
    'entorno',
  );
  expect(existsSync(process.env.PA_SECRETS_FILE as string)).toBe(false);
});
it('retains cooperating writer exclusion during prompts until the atomic batch commit', async () => {
  let release: () => void = () => {};
  const waiting = new Promise<void>((yes) => {
    release = yes;
  });
  let entered: () => void = () => {};
  const prompt = new Promise<void>((yes) => {
    entered = yes;
  });
  const setup = configurePortableVault(['setup'], async () => {
    entered();
    await waiting;
    return { setup: 'synthetic' };
  });
  await prompt;
  const writer = vaultSet('other', 'synthetic');
  release();
  await setup;
  await writer;
  expect(JSON.parse(readFileSync(process.env.PA_SECRETS_FILE as string, 'utf8'))).toEqual({
    setup: 'synthetic',
    other: 'synthetic',
  });
});
