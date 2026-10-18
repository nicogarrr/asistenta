import { expect, it, vi } from 'vitest';
import type { ReplyMessage } from '../src/mail/reader.js';
import { loadSendMailAccount, type ReplyDeps, replyOnOwnerRequest } from '../src/mail/reply.js';

const message: ReplyMessage = {
  id: '5',
  from: 'friend@example.test',
  to: ['me@gmail.com'],
  subject: 'Consulta',
  text: 'Pregunta',
  at: 1,
  seen: false,
  folder: 'INBOX',
  messageId: '<source@example.test>',
  references: [],
  replyTo: [],
  authenticationResults: '',
  threadDigest: 'hash',
  threadCount: 1,
};
function setup() {
  const read = vi.fn(async () => ({ ...message }));
  const send = vi.fn(async () => ({ ok: true, id: 'smtp-id' }));
  const review = vi.fn(async (_preview: string) => true);
  const reader = {
    address: 'me@gmail.com',
    password: 'abcdefghijklmnop',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
  };
  const deps: ReplyDeps = {
    readAccount: async () => reader,
    sendAccount: async () => ({ ...reader, smtpHost: 'smtp.gmail.com', smtpPort: 465 }),
    read,
    send,
    review,
  };
  return { deps, read, send, review };
}
it('shows exact account, recipient and text together, rereads, sends exact reviewed copy once', async () => {
  const s = setup();
  const result = await replyOnOwnerRequest('1:5', 'Sí, el martes.', s.deps);
  expect(result.ok).toBe(true);
  expect(s.review).toHaveBeenCalledWith(expect.stringContaining('Para: friend@example.test'));
  expect(s.review.mock.calls[0]?.[0]).toContain('Sí, el martes.');
  expect(s.read).toHaveBeenCalledTimes(2);
  expect(s.send).toHaveBeenCalledWith(expect.anything(), {
    to: ['friend@example.test'],
    subject: 'Re: Consulta',
    text: 'Sí, el martes.',
    inReplyTo: '<source@example.test>',
    references: ['<source@example.test>'],
  });
});
it('denied review cannot send', async () => {
  const s = setup();
  s.review.mockResolvedValue(false);
  await replyOnOwnerRequest('1:5', 'Hola', s.deps);
  expect(s.send).not.toHaveBeenCalled();
});
it('changed source cannot silently send after review', async () => {
  const s = setup();
  s.read
    .mockResolvedValueOnce(message)
    .mockResolvedValueOnce({ ...message, from: 'other@example.test' });
  const r = await replyOnOwnerRequest('1:5', 'Hola', s.deps);
  expect(r.ok).toBe(false);
  expect(s.send).not.toHaveBeenCalled();
});
it.each([
  'one@example.test, two@example.test',
  'evil\r\nBcc: other@example.test',
  'Display <one@example.test>',
])('rejects ambiguous/header-injected source %s', async (from) => {
  const s = setup();
  s.read.mockResolvedValue({ ...message, from });
  await expect(replyOnOwnerRequest('1:5', 'Hola', s.deps)).rejects.toThrow();
  expect(s.review).not.toHaveBeenCalled();
  expect(s.send).not.toHaveBeenCalled();
});
it('requires source epoch, forbids attachment or recipients supplied by model', async () => {
  const s = setup();
  await expect(replyOnOwnerRequest('5', 'Hola', s.deps)).rejects.toThrow();
  expect(s.read).not.toHaveBeenCalled();
});
it('loads only send namespace and does not fall back to read/general credentials', async () => {
  const get = vi.fn(
    async (key: string) =>
      ({ 'mailRead:password': 'abcdefghijklmnop', 'mail:password': 'abcdefghijklmnop' })[key] ??
      null,
  );
  expect(await loadSendMailAccount(get)).toBeNull();
  expect(get.mock.calls.map((c) => c[0])).toEqual(['mailSend:address', 'mailSend:password']);
});
it('mismatched sender account fails before preview/send', async () => {
  const s = setup();
  s.deps.sendAccount = async () => ({
    address: 'other@gmail.com',
    password: 'abcdefghijklmnop',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
  });
  await expect(replyOnOwnerRequest('1:5', 'Hola', s.deps)).rejects.toThrow('distintas');
  expect(s.send).not.toHaveBeenCalled();
});
it('new sent/thread message while reviewing prevents duplicate response', async () => {
  const s = setup();
  s.read
    .mockResolvedValueOnce(message)
    .mockResolvedValueOnce({ ...message, threadDigest: 'new sent reply' });
  expect((await replyOnOwnerRequest('1:5', 'Hola', s.deps)).ok).toBe(false);
  expect(s.send).not.toHaveBeenCalled();
});
