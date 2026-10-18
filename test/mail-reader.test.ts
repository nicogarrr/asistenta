import { expect, it } from 'vitest';
import { parseHeaderMetadata, resolveReplyCard } from '../src/mail/reader.js';

it('extracts exact RFC ids, unfolded references, auth only informative', () => {
  expect(
    parseHeaderMetadata(
      Buffer.from(
        'Message-ID: <a@example.test>\r\nReferences: <b@example.test>\r\n <c@example.test>\r\nAuthentication-Results: mx.google.com; dkim=pass',
      ),
    ),
  ).toEqual({
    messageId: '<a@example.test>',
    references: ['<b@example.test>', '<c@example.test>'],
    authenticationResults: 'mx.google.com; dkim=pass',
  });
});
it('rejects ambiguous duplicate Message-ID and header injection in id', () => {
  expect(
    parseHeaderMetadata(Buffer.from('Message-ID: <a@example.test>\r\nMessage-ID: <b@example.test>'))
      .messageId,
  ).toBeNull();
  expect(
    parseHeaderMetadata(Buffer.from('Message-ID: <a@example.test> garbage')).messageId,
  ).toBeNull();
});
it('that email resolves only by an explicit reply to a bot mail card, never last card', () => {
  const cards = new Map([
    ['card1', '1:5'],
    ['card2', '1:6'],
  ]);
  expect(resolveReplyCard('responde a ese\nHola', 'card1', cards)).toBe('1:5');
  expect(resolveReplyCard('responde a ese\nHola', undefined, cards)).toBeNull();
  expect(resolveReplyCard('responde a ese\nHola', 'unknown', cards)).toBeNull();
  expect(resolveReplyCard('resume ese', 'card1', cards)).toBeNull();
});
