import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';

it('SMTP failure always closes transport', async () => {
  let closed = false;
  vi.resetModules();
  vi.doMock('nodemailer', () => ({
    createTransport: () => ({
      verify: async () => {
        throw new Error('auth failed');
      },
      close: () => {
        closed = true;
      },
    }),
  }));
  const { verifyGmailSmtp } = await import('../src/books/setup-gmail.js');
  await expect(verifyGmailSmtp('fake@example.invalid', 'abcdefghijklmnop')).rejects.toThrow(
    'auth failed',
  );
  expect(closed).toBe(true);
  vi.doUnmock('nodemailer');
});

it('vault save errors never echo password', async () => {
  const { makeSetupHandler } = await import('../src/books/setup-page.js');
  const secret = 'abcdefghijklmnop';
  const server = createServer((req, res) =>
    makeSetupHandler({
      getFlow: async () => ({
        requestCode: async () => {},
        complete: async () => {},
      }),
      token: 'test',
      port: (server.address() as { port: number }).port,
      verifySmtp: async () => {},
      saveMail: async () => {
        throw new Error(`could not save ${secret}`);
      },
    })(req, res),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    const r = await fetch(`http://127.0.0.1:${port}/gmail?k=test`, {
      method: 'POST',
      body: new URLSearchParams({ gmail_address: 'fake@example.invalid', app_password: secret }),
    });
    expect(await r.text()).not.toContain(secret);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
