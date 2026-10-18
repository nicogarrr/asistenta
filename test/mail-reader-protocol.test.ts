import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  connect: vi.fn(),
  mailboxOpen: vi.fn(),
  search: vi.fn(),
  fetchOne: vi.fn(),
  list: vi.fn(),
  close: vi.fn(),
}));
vi.mock('imapflow', () => ({ ImapFlow: vi.fn(() => m) }));
const { readReplyThread, listReplyInbox } = await import('../src/mail/reader.js');
const account = {
  address: 'me@gmail.com',
  password: 'abcdefghijklmnop',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
};
beforeEach(() => {
  vi.clearAllMocks();
  m.connect.mockResolvedValue(undefined);
  m.mailboxOpen.mockResolvedValue({ readOnly: true, uidValidity: 1n });
  m.list.mockResolvedValue([{ specialUse: '\\All', path: 'All Mail' }]);
  m.search.mockResolvedValue([5]);
  m.fetchOne.mockResolvedValue({
    uid: 5,
    threadId: '12345',
    envelope: {
      from: [{ address: 'friend@example.test' }],
      subject: 'Hello',
      messageId: '<a@example.test>',
    },
    headers: Buffer.from('Message-ID: <a@example.test>'),
    source: Buffer.from('Subject: Hello\r\n\r\nHello'),
  });
});
it('uses read-only INBOX and All Mail, exact thread ID and valid RFC identity', async () => {
  const r = await readReplyThread(account, '1:5');
  expect(r?.messageId).toBe('<a@example.test>');
  expect(r?.threadCount).toBe(1);
  expect(r?.threadDigest.length).toBe(64);
  expect(m.mailboxOpen.mock.calls).toEqual([
    ['INBOX', { readOnly: true }],
    ['All Mail', { readOnly: true }],
  ]);
  expect(m.search).toHaveBeenCalledWith({ threadId: '12345' }, { uid: true });
  expect(m.close).toHaveBeenCalled();
});
it('rejects UID epoch changes before any fetch', async () => {
  m.mailboxOpen.mockResolvedValue({ readOnly: true, uidValidity: 2n });
  await expect(readReplyThread(account, '1:5')).rejects.toThrow('caducada');
  expect(m.fetchOne).not.toHaveBeenCalled();
});
it('rejects thread changes during snapshot, no stale send basis', async () => {
  m.search.mockResolvedValueOnce([5]).mockResolvedValueOnce([5, 6]);
  await expect(readReplyThread(account, '1:5')).rejects.toThrow('cambió');
});
it('rejects missing All Mail and missing RFC identity rather than inventing a header', async () => {
  m.list.mockResolvedValue([]);
  await expect(readReplyThread(account, '1:5')).rejects.toThrow('Todo');
});
it('list emits stable epoch-qualified references and never modifies flags', async () => {
  const r = await listReplyInbox(account);
  expect(r[0]?.ref).toBe('1:5');
  expect(m.fetchOne).toHaveBeenCalledWith('5', { uid: true, envelope: true }, { uid: true });
});
