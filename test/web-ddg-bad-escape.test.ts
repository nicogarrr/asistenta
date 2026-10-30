import { describe, expect, it } from 'vitest';
import { parseDuckDuckGoHtml } from '../src/web/backends.js';

const result = (href: string, title: string): string =>
  `<div class="result results_links results_links_deep web-result"><a class="result__a" href="${href}">${title}</a><a class="result__snippet" href="#">snip</a></div>`;

describe('ddg parser: un enlace con escape roto no tumba la búsqueda', () => {
  it('salta el resultado malo y conserva los buenos', () => {
    const html =
      result('//duckduckgo.com/l/?uddg=https%3A%2F%2Fbuena.es%2Fa&rut=x', 'Buena') +
      result('//duckduckgo.com/l/?uddg=https%3A%2F%2Fmala.es%2F%E0%A4%A&rut=y', 'Mala') +
      result('//duckduckgo.com/l/?uddg=https%3A%2F%2Fotra.es%2F&rut=z', 'Otra');
    const items = parseDuckDuckGoHtml(html);
    expect(items.map((i) => i.url)).toEqual(['https://buena.es/a', 'https://otra.es/']);
  });
});
