import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createPriceWatchTool } from '../src/tools/price-watch.js';
import { PageWatchStore } from '../src/watch/pages.js';

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// asis-bugs-20: el nombre de una vigilancia (80) y su palabra clave (60) se cortaban a
// ciegas; un emoji justo en el corte dejaba medio carácter, que la lista de /vigila y
// los avisos enseñan como «�».
describe('vigilancias: nombre y palabra clave largos sin medio emoji', () => {
  it('registro: nombre con emoji en el carácter 80 y palabra clave en el 60', () => {
    const watches = new PageWatchStore(new DatabaseSync(':memory:'));
    const w = watches.add(
      'chat-1',
      'https://example.com/x',
      `${'a'.repeat(79)}🎧 cascos`,
      `${'k'.repeat(59)}🔥 oferta`,
    );
    expect(w.label).toBe('a'.repeat(79));
    expect(w.keyword).toBe('k'.repeat(59));
    expect(w.label).not.toMatch(LONE);
    expect(w.keyword).not.toMatch(LONE);
  });

  it('herramienta vigilar_precio: nombre con emoji en el carácter 80', async () => {
    const watches = new PageWatchStore(new DatabaseSync(':memory:'));
    const tool = createPriceWatchTool({
      watches,
      scopeOf: () => 'chat-1',
      isFetchable: async () => true,
    });
    const r = await tool.execute('t', {
      action: 'add',
      url: 'https://example.com/y',
      label: `${'b'.repeat(79)}🎧 cascos`,
    } as never);
    const c = r.content[0];
    const text = c && c.type === 'text' ? c.text : '';
    const [w] = watches.list('chat-1');
    expect(w?.label).toBe('b'.repeat(79));
    expect(text).not.toMatch(LONE);
  });
});
