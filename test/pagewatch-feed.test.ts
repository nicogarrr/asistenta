import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { describeChange, PageWatchStore, parseFeedItems, watchValue } from '../src/watch/pages.js';

const rss = (items: [string, string][]): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>${items
    .map(
      ([t, l]) =>
        `<item><title><![CDATA[${t}]]></title><link>${l}</link><description>Oferta: 19,99 € hoy</description></item>`,
    )
    .join('')}</channel></rss>`;

const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Noticias</title>
<entry><title>Uno &amp; dos</title><link rel="alternate" href="https://ej.es/1"/><id>tag:1</id><summary>Precio 5 €</summary></entry>
</feed>`;

describe('vigilar un feed RSS/Atom', () => {
  it('lee títulos y enlaces de RSS y Atom', () => {
    expect(parseFeedItems(rss([['Hola', 'https://ej.es/a']]))).toEqual([
      { title: 'Hola', link: 'https://ej.es/a', id: 'https://ej.es/a' },
    ]);
    expect(parseFeedItems(atom)).toEqual([
      { title: 'Uno & dos', link: 'https://ej.es/1', id: 'tag:1' },
    ]);
    expect(parseFeedItems('<html><body>Precio 19,99 €</body></html>')).toBeNull();
  });

  it('nunca toma un precio de una entrada del feed', () => {
    expect(watchValue(rss([['Hola', 'https://ej.es/a']]))).toMatch(/^feed:/);
    expect(watchValue(atom)).toMatch(/^feed:/);
  });

  it('avisa de las entradas nuevas con título y enlace, no «cambio de precio»', async () => {
    const store = new PageWatchStore(new DatabaseSync(':memory:'));
    let body = rss([['Viejo', 'https://ej.es/v']]);
    const w = store.add('chat', 'https://ej.es/feed.xml', 'Blog');
    expect((await store.check(w, async () => body)).kind).toBe('baseline');
    expect((await store.check(store.get(w.id)!, async () => body)).kind).toBe('unchanged');
    body = rss([
      ['Nuevo post', 'https://ej.es/n'],
      ['Viejo', 'https://ej.es/v'],
    ]);
    const w2 = store.get(w.id)!;
    const o = await store.check(w2, async () => body);
    expect(o.kind).toBe('changed');
    const msg = describeChange(w2, o) ?? '';
    expect(msg).toContain('Nuevo post');
    expect(msg).toContain('https://ej.es/n');
    expect(msg).not.toContain('Viejo');
    expect(msg).not.toMatch(/precio/i);
    expect(msg).not.toContain('ha cambiado');
  });

  it('una entrada que sale del feed sin ninguna nueva no avisa', async () => {
    const store = new PageWatchStore(new DatabaseSync(':memory:'));
    let body = rss([
      ['A', 'https://ej.es/a'],
      ['B', 'https://ej.es/b'],
    ]);
    const w = store.add('chat', 'https://ej.es/feed.xml');
    await store.check(w, async () => body);
    body = rss([['A', 'https://ej.es/a']]);
    expect((await store.check(store.get(w.id)!, async () => body)).kind).toBe('unchanged');
  });

  it('una vigilancia guardada antes (precio sacado de un post) pasa a feed sin aviso falso', async () => {
    const store = new PageWatchStore(new DatabaseSync(':memory:'));
    const w = store.add('chat', 'https://ej.es/feed.xml');
    await store.check(w, async () => 'Oferta 19,99 €');
    const o = await store.check(store.get(w.id)!, async () => rss([['Hola', 'https://ej.es/a']]));
    expect(o.kind).toBe('baseline');
  });
});
