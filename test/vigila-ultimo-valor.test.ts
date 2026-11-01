import { describe, expect, it } from 'vitest';
import { formatWatchList } from '../src/cli.js';
import { describeWatch, type PageWatch, watchValueText } from '../src/watch/pages.js';

const watch = (lastValue: string): PageWatch =>
  ({
    id: 'a1b2',
    scope: 'chat',
    url: 'https://ej.es/x',
    label: 'Blog',
    lastValue,
    keyword: '',
    targetCents: null,
    dropPct: null,
    mutedUntil: 0,
  }) as unknown as PageWatch;

describe('último valor legible en /vigila y /precio', () => {
  it('no enseña el hash interno de texto ni de feed', () => {
    expect(watchValueText('texto:0123456789abcdef')).toBe('texto sin precio claro');
    expect(watchValueText('feed:aa,bb,cc')).toBe('feed con 3 entradas');
    expect(watchValueText('presente')).toBe('la palabra aparece');
    expect(watchValueText('49,90 €')).toBe('49,90 €');
    expect(watchValueText('')).toBe('pendiente');
  });

  it('la lista y la ficha usan el texto legible', () => {
    const list = formatWatchList([watch('texto:0123456789abcdef')]);
    expect(list).toContain('último valor: texto sin precio claro');
    expect(list).not.toContain('0123456789abcdef');
    const card = describeWatch(watch('feed:aa,bb'), null);
    expect(card).toContain('último valor: feed con 2 entradas');
    expect(card).not.toContain('feed:aa');
  });
});
