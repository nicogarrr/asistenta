import { describe, expect, it } from 'vitest';
import { skillsSearchReply } from '../src/cli.js';

const failing = (err: unknown) =>
  (async () => {
    throw err;
  }) as unknown as typeof fetch;

describe('/skills buscar: si el índice no se puede leer, mensaje amable', () => {
  it('sin conexión: frase en español, sin «fetch failed»', async () => {
    const r = await skillsSearchReply(
      'tele',
      'https://example.com/index.json',
      failing(new TypeError('fetch failed')),
    );
    expect(r).toMatch(/^No he podido leer el índice de skills/);
    expect(r).not.toContain('fetch failed');
    expect(r).not.toContain('TypeError');
  });

  it('fallo interno: sin pila ni texto de programación', async () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'map')");
    const r = await skillsSearchReply('tele', 'https://example.com/index.json', failing(err));
    expect(r).toMatch(/^No he podido leer el índice de skills/);
    expect(r).not.toContain('Cannot read');
  });
});
