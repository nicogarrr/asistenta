import { describe, expect, it } from 'vitest';
import { booksSetupCommand } from '../src/books/setup-cli.js';

describe('booksSetupCommand', () => {
  it('imprime la URL local con token y el server responde', async () => {
    let printed = '';
    const handle = booksSetupCommand(18381, (text) => {
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
});
