import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrowserService,
  compactPick,
  expandRef,
  formatCompactSnapshot,
  formatSnapshot,
  type PageElement,
  type PageScan,
  snapshotVerbose,
} from '../src/browser/service.js';
import { createBrowserTool } from '../src/tools/browser.js';
import { describeBrowser } from './helpers/real-browser.js';

/**
 * resumen-pagina-1: the page snapshot is what the model pays for on every browser step.
 * On the Wikipedia home page it was 16,159 characters (a 7-step search+click task cost
 * ~40,000), mostly nth-of-type paths and a false «ABIERTO» on every menu link, and it
 * still did not carry the price of a product page. These tests hold the compact shape:
 * a size budget, refs that click, the price and headings present, and the old format one
 * env var away.
 */

function el(i: number, over: Partial<PageElement> = {}): PageElement {
  return {
    index: i,
    kind: 'link',
    role: 'link',
    name: `Enlace ${i}`,
    value: '',
    selector: `div:nth-of-type(1) > ul:nth-of-type(2) > li:nth-of-type(${i}) > a:nth-of-type(1)`,
    ref: `e${i + 1}`,
    inView: i < 10,
    openSuggestions: 0,
    ...over,
  } as PageElement;
}

function scanOf(elements: PageElement[], over: Partial<PageScan> = {}): PageScan {
  return {
    title: 'Ficha',
    url: 'https://tienda.example/p/1',
    total: elements.length,
    openSuggestions: 0,
    openPanels: 0,
    suggestions: [],
    elements,
    ...over,
  } as PageScan;
}

describe('snapshot compacto (formato)', () => {
  it('expandRef convierte e12 / @e12 / [e12] en el selector del nodo y deja lo demás', () => {
    expect(expandRef('e12')).toBe('[data-pa-ref="e12"]');
    expect(expandRef(' @E7 ')).toBe('[data-pa-ref="e7"]');
    expect(expandRef('[e3]')).toBe('[data-pa-ref="e3"]');
    expect(expandRef('#buscar')).toBe('#buscar');
    expect(expandRef('Euros')).toBe('Euros');
    expect(expandRef('e12 resultados')).toBe('e12 resultados');
  });

  it('lo que está a la vista va primero y el resto se cuenta, no se lista', () => {
    const els = Array.from({ length: 120 }, (_, i) => el(i));
    const picked = compactPick(els, 45);
    expect(picked).toHaveLength(45);
    // The ten in view are all there, and order on screen is document order.
    for (let i = 0; i < 10; i++) expect(picked).toContain(els[i]);
    expect(picked.map((e) => e.index)).toEqual(
      [...picked.map((e) => e.index)].sort((a, b) => a - b),
    );
    const text = formatCompactSnapshot(scanOf(els));
    expect(text).toMatch(/\+75 fuera de la vista/);
    expect(text).toContain('full=true');
  });

  it('un campo con sugerencias abiertas entra siempre, aunque esté fuera de la vista', () => {
    const els = Array.from({ length: 80 }, (_, i) => el(i));
    els[79] = el(79, { kind: 'textbox', role: 'combobox', inView: false, openSuggestions: 3 });
    const text = formatCompactSnapshot(
      scanOf(els, { openSuggestions: 1, suggestions: ['Sevilla'] }),
    );
    expect(text).toMatch(/^e80\[combobox\].*ABIERTO:3 opciones$/m);
    expect(text).toMatch(/^ATENCION/m);
  });

  it('usa el selector propio si es corto y el ref si solo había un camino nth-of-type', () => {
    const text = formatCompactSnapshot(
      scanOf([
        el(0, {
          kind: 'textbox',
          role: '',
          selector: 'input#fecha',
          value: '03/10/2026',
          name: 'Fecha',
        }),
        el(1),
        el(2, { name: 'link', href: '/carrito' }),
      ]),
    );
    expect(text).toContain('input#fecha[textbox] value="03/10/2026" "Fecha"');
    expect(text).toContain('e2[link] "Enlace 1"');
    expect(text).not.toContain('nth-of-type');
    // A link with no words of its own is named by where it goes.
    expect(text).toContain('e3[link] "/carrito"');
  });

  it('enseña encabezados, precios y el arranque del texto', () => {
    const text = formatCompactSnapshot(
      scanOf([el(0)], {
        headings: ['Kindle Paperwhite', 'Opiniones'],
        prices: ['Precio: 169,99 €'],
        text: 'El Kindle más fino hasta ahora.',
      }),
    );
    expect(text).toContain('Encabezados: Kindle Paperwhite · Opiniones');
    expect(text).toContain('Precios: «Precio: 169,99 €»');
    expect(text).toContain('Texto: El Kindle más fino');
  });

  it('PA_BROWSER_SNAPSHOT=verbose devuelve el formato largo de antes', () => {
    expect(snapshotVerbose({ PA_BROWSER_SNAPSHOT: 'verbose' })).toBe(true);
    expect(snapshotVerbose({})).toBe(false);
    expect(snapshotVerbose({ PA_BROWSER_SNAPSHOT: 'compacto' })).toBe(false);
    const long = formatSnapshot(scanOf([el(0)]));
    expect(long).toContain('nth-of-type');
    expect(long).toContain('[0]');
  });
});

/** A shop page shaped like the real ones: a big menu twice, a price, a long article. */
function fixture(): string {
  const menu = Array.from(
    { length: 40 },
    (_, i) => `<li><a href="/cat/${i}">Categoría número ${i} de la tienda</a></li>`,
  ).join('');
  const body = Array.from(
    { length: 160 },
    (_, i) =>
      `<p>Párrafo ${i} con un <a href="/art/${i}">artículo relacionado ${i}</a> y algo de texto alrededor.</p>`,
  ).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Cafetera Express</title>
  <style>body{margin:0;font-family:sans-serif} nav ul{display:flex;flex-wrap:wrap;gap:4px;list-style:none;padding:0}</style>
  </head><body>
  <header><a href="/"><img alt="" width="80" height="20"></a>
    <input id="q" name="q" type="search" placeholder="Buscar en la tienda">
    <nav><ul>${menu}</ul></nav></header>
  <main>
    <h1>Cafetera Express Barista</h1>
    <p>Una cafetera de 15 bares con vaporizador para hacer capuchinos en casa sin complicaciones.</p>
    <div class="buybox"><span class="label">Precio:</span> <span class="price">129,99 €</span>
      <button id="comprar">Añadir a la cesta</button>
      <button onclick="document.title='Cesta lista'">Comprar ya</button></div>
    <h2>Descripción</h2>${body}
  </main>
  <footer><nav><ul>${menu}</ul></nav></footer>
  </body></html>`;
}

describeBrowser('snapshot compacto en una página real', () => {
  let server: Server;
  let base: string;
  let dir: string;
  let service: BrowserService;
  const scope = 'resumen1';

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fixture());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    dir = mkdtempSync(join(tmpdir(), 'pa-resumen1-'));
    service = new BrowserService({
      policy: { approve: async () => true, allowPrivateHosts: true },
      profilesDir: dir,
    });
    await service.open(scope, `${base}/ficha`);
  });

  afterAll(async () => {
    delete process.env.PA_BROWSER_SNAPSHOT;
    await service.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('cabe en el presupuesto, menos de la mitad que el formato largo, con el precio', async () => {
    const compact = await service.snapshot(scope);
    process.env.PA_BROWSER_SNAPSHOT = 'verbose';
    const verbose = await service.snapshot(scope);
    delete process.env.PA_BROWSER_SNAPSHOT;
    expect(compact.length).toBeLessThan(3_500);
    expect(compact.length * 2).toBeLessThan(verbose.length);
    expect(compact).toContain('129,99 €');
    expect(compact).toContain('Cafetera Express Barista');
    expect(compact).toContain('input#q[searchbox]');
    expect(compact).toMatch(/"Añadir a la cesta"/);
    // A menu link with a list under it is not an open suggestion panel.
    expect(compact).not.toMatch(/ATENCION|ABIERTO/);
    // The footer repeats the menu: listed once.
    expect(compact.match(/"Categoría número 3 de la tienda"/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it('los refs son estables entre snapshots y el clic por ref llega al elemento', async () => {
    const first = await service.snapshot(scope);
    const second = await service.snapshot(scope);
    const line = (s: string) => s.split('\n').find((l) => l.includes('"Comprar ya"')) ?? '';
    const ref = line(first).slice(0, line(first).indexOf('['));
    expect(ref).toMatch(/^e\d+$/);
    expect(line(second).startsWith(`${ref}[`)).toBe(true);

    const tool = createBrowserTool(service, () => scope);
    const out = await tool.execute(
      'x',
      { action: 'click', selector: ref } as never,
      undefined as never,
      undefined as never,
    );
    const text = (out.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
    expect(text).toMatch(/^clicked/);
    const title = await service.execJs(scope, 'return await page.title();');
    expect(title.text).toBe('Cesta lista');
  });

  it('full=true lista también lo que está fuera de la vista', async () => {
    const compact = await service.snapshot(scope);
    const full = await service.snapshot(scope, 120, { full: true });
    expect(compact).toMatch(/fuera de la vista/);
    expect(full).toContain('"artículo relacionado 100"');
    expect(compact).not.toContain('"artículo relacionado 100"');
  });
});
