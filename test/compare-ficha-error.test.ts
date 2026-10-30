import { describe, expect, it } from 'vitest';
import { compareProduct } from '../src/watch/compare.js';

async function failWith(err: unknown): Promise<string> {
  try {
    await compareProduct('https://www.pccomponentes.com/tele-55', {
      fetchHtml: async () => {
        throw err;
      },
      sleep: async () => {},
    });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return 'no falló';
}

describe('/compara: si no puedo leer la ficha, lo digo en español y sin texto técnico', () => {
  it.each([
    [new Error('403 Forbidden for https://www.pccomponentes.com/tele-55'), 'no me deja leerla'],
    [new Error('404 Not Found for https://www.pccomponentes.com/tele-55'), 'ya no existe'],
    [new Error('503 Service Unavailable for https://x'), 'está fallando'],
    [
      new Error('fetch timed out after 20s: https://www.pccomponentes.com/tele-55'),
      'tardado demasiado',
    ],
    [new TypeError('fetch failed'), 'no consigo conectar'],
    [
      new Error('refusing to fetch http://10.0.0.1/: not a public http(s) URL'),
      'no es una página web pública',
    ],
    [new Error('algo raro'), 'no me ha devuelto la página'],
  ])('%s', async (err, expected) => {
    const msg = await failWith(err);
    expect(msg).toContain('no pude leer la ficha que me pasas: ');
    expect(msg).toContain(expected);
    expect(msg).not.toMatch(
      /https?:|Forbidden|Not Found|timed out|fetch failed|refusing|algo raro/,
    );
  });
});
