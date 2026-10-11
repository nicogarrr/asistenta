import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

it('does not dispose while a setup request is in flight', async () => {
  vi.resetModules();
  process.env.BOOKS_ENV_PATH = join(mkdtempSync(join(tmpdir(), 'books-race-')), '.env');
  process.env.BOOKS_TG_PHONE = '+34000000000';
  const { LoginFlow } = await import('../src/books/userbot.js');
  let calls = 0,
    active = false,
    disposedActive = false;
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  const gate = new Promise<void>((r) => (release = r));
  vi.spyOn(LoginFlow.prototype, 'requestCode').mockImplementation(async () => {
    calls++;
    if (calls === 1) {
      active = true;
      entered();
      await gate;
      active = false;
    }
  });
  vi.spyOn(LoginFlow.prototype, 'dispose').mockImplementation(async () => {
    if (active) disposedActive = true;
  });
  const { startSetupServer } = await import('../src/books/setup-page.js');
  const { server, token } = startSetupServer(18378);
  await new Promise<void>((r) => server.once('listening', r));
  const post = (id: string) =>
    fetch(`http://127.0.0.1:18378/setup?k=${token}`, {
      method: 'POST',
      body: new URLSearchParams({ api_id: id, api_hash: 'a'.repeat(32) }),
    });
  try {
    const first = post('123');
    await started;
    const second = post('456');
    await new Promise((r) => setTimeout(r, 100));
    release();
    await Promise.all([first, second]);
    expect(disposedActive).toBe(false);
  } finally {
    release();
    await new Promise<void>((r) => server.close(() => r()));
    vi.restoreAllMocks();
  }
});
