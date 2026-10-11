import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it('second setup uses newly saved credentials', async () => {
  vi.resetModules();
  process.env.BOOKS_ENV_PATH = join(mkdtempSync(join(tmpdir(), 'books-audit-')), '.env');
  process.env.BOOKS_TG_PHONE = '+34000000000';
  const { LoginFlow } = await import('../src/books/userbot.js');
  const used: unknown[] = [];
  vi.spyOn(LoginFlow.prototype, 'requestCode').mockImplementation(async function (
    this: InstanceType<typeof LoginFlow>,
  ) {
    used.push((this as unknown as { config: unknown }).config);
  });
  const { startSetupServer } = await import('../src/books/setup-page.js');
  const { server, token } = startSetupServer(18377);
  await new Promise<void>((r) => server.once('listening', r));
  try {
    for (const id of ['123', '456']) {
      const res = await fetch(`http://127.0.0.1:18377/setup?k=${token}`, {
        method: 'POST',
        body: new URLSearchParams({ api_id: id, api_hash: 'a'.repeat(32) }),
      });
      expect(res.status).toBe(200);
    }
    expect((used[1] as { apiId: number }).apiId).toBe(456);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    vi.restoreAllMocks();
  }
});
