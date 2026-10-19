import { expect, it } from 'vitest';
import { mailStatus } from '../src/mail/status.js';

const store = (o: Record<string, string>) => async (k: string) => o[k];
it('reports missing without leaking anything', async () => {
  const s = await mailStatus(store({}));
  expect(s.read).toBe('falta');
  expect(s.send).toBe('falta');
  expect(s.lines.join(' ')).toContain('set-stdin');
});
it('ok when both valid and same account; never prints values', async () => {
  const s = await mailStatus(
    store({
      'mailRead:address': 'Nico@gmail.com',
      'mailRead:password': 'abcd efgh ijkl mnop',
      'mailSend:address': 'nico@gmail.com',
      'mailSend:password': 'abcdefghijklmnop',
    }),
  );
  expect([s.read, s.send, s.sameAccount]).toEqual(['ok', 'ok', true]);
  const text = s.lines.join(' ');
  expect(text).not.toMatch(/abcd|gmail\.com/i);
});
it('flags invalid and mismatched accounts', async () => {
  const bad = await mailStatus(
    store({ 'mailRead:address': 'x@example.com', 'mailRead:password': 'short' }),
  );
  expect(bad.read).toBe('invalida');
  const mism = await mailStatus(
    store({
      'mailRead:address': 'a@gmail.com',
      'mailRead:password': 'abcdefghijklmnop',
      'mailSend:address': 'b@gmail.com',
      'mailSend:password': 'abcdefghijklmnop',
    }),
  );
  expect(mism.sameAccount).toBe(false);
  expect(mism.lines.join(' ')).toContain('distintas');
});
