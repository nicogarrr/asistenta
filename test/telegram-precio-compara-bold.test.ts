import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { marksCardTitle, telegramHtml } from '../src/channels/formatters.js';
import { commandButton, commandFromCallback } from '../src/channels/telegram.js';
import { watchListButtons } from '../src/cli.js';
import { describeWatch, type PageWatch } from '../src/watch/pages.js';

/**
 * /precio y /compara con el nombre en negrita (como /vigilando y /cron), y en
 * /vigilando un botón «📈 Precio …» de solo lectura al lado de «🗑 Dejar de vigilar …».
 */
const watch = {
  id: 'a1b2',
  scope: 'telegram:42',
  url: 'https://tienda.example/p?x=1&y=2',
  label: 'Zapatillas **oferta** `x`',
  lastValue: '49,90 €',
  lastCheckedAt: 0,
  failures: 0,
  createdAt: 0,
  active: true,
  keyword: '',
  targetCents: 4000,
  dropPct: null,
} as unknown as PageWatch;

describe('ficha con nombre en negrita', () => {
  it('marksCardTitle: solo la primera línea en <b>; el texto del usuario no formatea', () => {
    const html = telegramHtml(marksCardTitle(describeWatch(watch, null)));
    expect(html.startsWith('<b>Zapatillas')).toBe(true);
    expect(html.split('\n')[0]).toContain('(id a1b2)</b>');
    expect(html.match(/<b>/g)).toHaveLength(1);
    expect(html).not.toContain('<code>');
    expect(html).toContain('x=1&amp;y=2');
  });

  it('una primera línea vacía no deja un ** suelto', () => {
    expect(marksCardTitle('\nresto')).toBe('\nresto');
  });

  it('cmdPrecio y cmdCompara mandan la ficha con marksCardTitle y formato marks', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const precio = src.slice(src.indexOf('const cmdPrecio = async')).slice(0, 700);
    expect(precio).toContain('marksCardTitle(describeWatch(w, pageWatches.summary(w.id)))');
    expect(precio).toContain("format: 'marks'");
    const compara = src.slice(src.indexOf('const cmdCompara = async')).slice(0, 1800);
    expect(compara).toContain(
      "marksCardTitle(describeCompare(report)), { quote: true, format: 'marks' }",
    );
    const vigilando = src.slice(src.indexOf('const cmdVigilando = async')).slice(0, 400);
    expect(vigilando).toContain('buttons: watchListButtons(list)');
  });
});

describe('/vigilando: «📈 Precio» al lado de «🗑 Dejar de vigilar»', () => {
  it('el botón de precio se lee como /precio <id>', () => {
    const b = commandButton('📈 Precio PS5', 'precio', 'a1');
    expect(b).toEqual({ label: '📈 Precio PS5', action: 'cmd:precio a1' });
    expect(commandFromCallback('cmd:precio a1')).toBe('/precio a1');
    expect(commandFromCallback('cmd:precio borrar a1')).toBeUndefined();
  });

  it('una pareja por página, precio primero (misma fila)', () => {
    const buttons = watchListButtons([
      { id: 'a1', label: 'PS5', url: 'https://tienda.example/ps5' },
      { id: 'b2', label: '', url: 'https://tienda.example/tv' },
    ]);
    expect(buttons?.map((b) => b.action)).toEqual([
      'cmd:precio a1',
      'cmd:dejar_de_vigilar a1',
      'cmd:precio b2',
      'cmd:dejar_de_vigilar b2',
    ]);
    expect(buttons?.[0]?.label).toBe('📈 Precio PS5');
    expect(buttons?.[2]?.label.startsWith('📈 Precio https://tienda')).toBe(true);
  });

  it('sin páginas no hay botones; como mucho 8 páginas', () => {
    expect(watchListButtons([])).toBeUndefined();
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `w${i}`, label: `P${i}`, url: 'u' }));
    expect(watchListButtons(many)).toHaveLength(16);
  });
});
