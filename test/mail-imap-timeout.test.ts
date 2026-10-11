import { describe, expect, it, vi } from 'vitest';
import type { MailAccount } from '../src/mail/types.js';

const close = vi.fn();
const logout = vi.fn(async () => {});
const connect = vi.fn();
const getMailboxLock = vi.fn(async () => ({ release: vi.fn() }));

vi.mock('imapflow', () => ({
  ImapFlow: vi.fn(() => ({ connect, getMailboxLock, close, logout })),
}));

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { searchMail } = await import('../src/mail/client.js');

const ACCOUNT: MailAccount = {
  address: 'yo@ejemplo.com',
  password: 'super-secreta-1234',
  imapHost: 'imap.ejemplo.com',
  imapPort: 993,
  smtpHost: 'smtp.ejemplo.com',
  smtpPort: 465,
};

describe('searchMail con deadline', () => {
  it('un IMAP colgado muere al deadline: rechaza y cierra el socket, no se apila', async () => {
    connect.mockReturnValue(new Promise<void>(() => undefined));
    close.mockClear();
    const started = Date.now();
    await expect(searchMail(ACCOUNT, {}, 5, 30)).rejects.toThrow(/más de 30 ms/);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
