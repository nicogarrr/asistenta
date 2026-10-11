import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { booksSetupCommand } from '../src/books/setup-cli.js';

describe('booksSetupCommand', () => {
  it('imprime la URL local con token y el server responde', async () => {
    let printed = '';
    const handle = await booksSetupCommand(18381, (text) => {
      printed += text;
    });
    try {
      const match = printed.match(/http:\/\/127\.0\.0\.1:18381\/\?k=([a-f0-9]{48})/);
      const token = match?.[1];
      expect(token).toBeDefined();
      const ok = await fetch(`http://127.0.0.1:18381/?k=${token}`);
      expect(ok.status).toBe(200);
      const forbidden = await fetch('http://127.0.0.1:18381/');
      expect(forbidden.status).toBe(403);
    } finally {
      handle.close();
    }
  });

  it('no anuncia la URL si el puerto esta pillado (EADDRINUSE)', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(18382, '127.0.0.1', resolve));
    let printed = '';
    try {
      await expect(
        booksSetupCommand(18382, (text) => {
          printed += text;
        }),
      ).rejects.toThrow(/puerto 18382/);
      expect(printed).toBe('');
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
