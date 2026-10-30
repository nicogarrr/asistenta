import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isCronTitle,
  isWatchListTitle,
  marksWithTitles,
  telegramHtml,
} from '../src/channels/formatters.js';
import { formatWatchList } from '../src/cli.js';
import type { PageWatch } from '../src/watch/pages.js';

/**
 * /cron (la lista) y /vigilando con cabecera en negrita, como /recordatorios, /agenda
 * y /estado: solo la cabecera va en <b>; nombres de rutina, etiquetas y URLs del
 * usuario se escapan, así que un `**` o un acento grave nunca formatean.
 */
const watch = (over: Partial<PageWatch>): PageWatch =>
  ({
    id: 'a1b2',
    scope: 'telegram:42',
    url: 'https://tienda.example/p?x=1&y=2',
    label: '',
    lastValue: '',
    lastCheckedAt: 0,
    failures: 0,
    createdAt: 0,
    active: true,
    keyword: '',
    targetCents: null,
    dropPct: null,
    ...over,
  }) as PageWatch;

describe('/vigilando con cabecera en negrita', () => {
  it('formatWatchList lleva «Páginas vigiladas: N» y una línea por página', () => {
    const text = formatWatchList([
      watch({ label: 'Zapatillas **oferta**', lastValue: '49,90 €', targetCents: 4000 }),
      watch({ id: 'c3d4', dropPct: 10 }),
    ]);
    const lines = text.split('\n');
    expect(lines[0]).toBe('Páginas vigiladas: 2');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('a1b2 - Zapatillas **oferta** - último valor: 49,90 €');
    expect(lines[1]).toContain('objetivo');
    expect(lines[2]).toContain('último valor: pendiente - aviso si baja un 10 %');
  });

  it('sin páginas: el mismo aviso de siempre, sin cabecera', () => {
    expect(formatWatchList([])).toBe('No vigilo ninguna página. Prueba /vigila <enlace>.');
  });

  it('en HTML: solo la cabecera en <b>, etiquetas y URLs escapadas', () => {
    const html = telegramHtml(
      marksWithTitles(
        formatWatchList([watch({ label: 'Zapatillas **oferta** `x`' })]),
        isWatchListTitle,
      ),
    );
    expect(html.startsWith('<b>Páginas vigiladas: 1</b>\n')).toBe(true);
    expect(html.match(/<b>/g)).toHaveLength(1);
    expect(html).not.toContain('<code>');
    expect(isWatchListTitle('Páginas vigiladas: 1 de 3')).toBe(false);
    expect(isWatchListTitle('a1b2 - Páginas vigiladas: 1')).toBe(false);
  });

  it('cmdVigilando manda la lista con marksWithTitles(…, isWatchListTitle) y formato marks', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('const cmdVigilando = async')).slice(0, 600);
    expect(body).toContain('formatWatchList(pageWatches.list(inbound.chatId))');
    expect(body).toContain(
      "marksWithTitles(text, isWatchListTitle), { quote: true, format: 'marks' }",
    );
  });
});

describe('/cron (lista) con cabecera en negrita', () => {
  const lista = [
    'Rutinas programadas: 2',
    '- resumen **diario** [0 8 * * *] — próxima: mañana 08:00',
    '- `backup` [0 3 * * *] — EN PAUSA',
  ].join('\n');

  it('reconoce solo la cabecera', () => {
    expect(lista.split('\n').filter(isCronTitle)).toEqual(['Rutinas programadas: 2']);
    expect(isCronTitle('Rutinas programadas: dos')).toBe(false);
    expect(isCronTitle('- Rutinas programadas: 2')).toBe(false);
  });

  it('en HTML: cabecera en <b>, nombres de rutina escapados', () => {
    const html = telegramHtml(marksWithTitles(lista, isCronTitle));
    expect(html.startsWith('<b>Rutinas programadas: 2</b>\n')).toBe(true);
    expect(html.match(/<b>/g)).toHaveLength(1);
    expect(html).not.toContain('<code>');
  });

  it('cmdCron manda runCronCommand con marksWithTitles(…, isCronTitle) y formato marks', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('const cmdCron = async')).slice(0, 1500);
    expect(body).toContain('marksWithTitles(\n      runCronCommand(');
    expect(body).toContain('isCronTitle,');
    expect(body).toContain("await say(inbound, text, { quote: true, format: 'marks' });");
  });
});
