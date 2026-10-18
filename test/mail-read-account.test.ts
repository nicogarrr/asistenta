import { expect, it, vi } from 'vitest';
import { loadReadMailAccount } from '../src/mail/idle.js';

it('loads only the dedicated read namespace and never general mail or SMTP secrets', async () => {
  const get = vi.fn(
    async (key: string) =>
      ({
        'mailRead:address': 'me@gmail.com',
        'mailRead:password': 'abcd efgh ijkl mnop',
        'mail:password': 'MUST NOT USE',
        'mailRead:imapHost': 'evil.test',
      })[key] ?? null,
  );
  const account = await loadReadMailAccount(get);
  expect(get.mock.calls.map((c) => c[0])).toEqual(['mailRead:address', 'mailRead:password']);
  expect(account).toEqual({
    address: 'me@gmail.com',
    password: 'abcdefghijklmnop',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
  });
  expect(account).not.toHaveProperty('smtpHost');
});
it.each([
  {},
  { 'mailRead:address': 'me@gmail.com' },
  { 'mailRead:password': 'secret' },
  { 'mail:address': 'me@gmail.com', 'mail:password': 'secret' },
])('no fallback to general mail: %j', async (values) => {
  expect(
    await loadReadMailAccount(async (key) => (values as Record<string, string>)[key] ?? null),
  ).toBeNull();
});
it('rejects non Gmail destination rather than forwarding this credential elsewhere', async () => {
  await expect(
    loadReadMailAccount(async (key) => (key.endsWith('address') ? 'me@evil.test' : 'secret')),
  ).rejects.toThrow('Gmail');
});
it.each(['', '   ', 'normal-password', 'abcd efgh ijkl 1234', 'abcdefghijklmnop\n'])(
  'rejects malformed app password without printing it',
  async (secret) => {
    const load = loadReadMailAccount(async (key) =>
      key.endsWith('address') ? 'me@gmail.com' : secret,
    );
    if (!secret) expect(await load).toBeNull();
    else await expect(load).rejects.toThrow('16 caracteres');
  },
);
