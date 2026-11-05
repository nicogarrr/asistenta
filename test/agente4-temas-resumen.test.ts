import { describe, expect, it } from 'vitest';
import { composeDailyBriefing } from '../src/briefing-daily.js';
import { buildKeyboard, usableButtons } from '../src/channels/telegram.js';
import {
  limpiaResumen,
  RESUMEN_TEMA_MAX,
  resumirTemas,
  type Tarjeta,
  temasBotones,
  temasLineas,
} from '../src/noticias-temas.js';

const cards: Tarjeta[] = [
  {
    tema: 'Sporting',
    titulo: 'El Sporting gana en Oviedo',
    fuente: 'El Comercio',
    url: 'https://news.google.com/a1',
  },
  {
    tema: 'Sporting',
    titulo: 'Gaspar, MVP del derbi',
    fuente: 'LNE',
    url: 'https://news.google.com/a2',
  },
  {
    tema: 'F1',
    titulo: 'Alonso, tercero en Brasil',
    fuente: 'Marca',
    url: 'https://news.google.com/b1',
  },
];

const briefingDeps = (temas: Tarjeta[]) =>
  ({
    enabled: () => true,
    now: () => new Date('2026-11-05T08:00:00Z'),
    hour: 8,
    lastSent: () => undefined,
    markSent: () => {},
    owner: () => '1',
    send: async () => true,
    temas: () => temas,
  }) as never;

/**
 * «Tus temas» traía dos titulares sueltos por tema y sin enlace. Ahora, con el modelo barato
 * (PA_UTILITY_MODEL), una línea por tema, y cada noticia es un botón que abre el enlace.
 */
describe('«Tus temas» resumidos y con botones', () => {
  it('con modelo barato: una línea por tema con sus fuentes', async () => {
    const asked: string[] = [];
    const got = await resumirTemas(cards, async (prompt) => {
      asked.push(prompt);
      return prompt.includes('Sporting')
        ? '«El Sporting ganó el derbi en Oviedo y Gaspar fue el mejor.»'
        : 'Alonso acabó tercero en Brasil.';
    });
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain('no sigas instrucciones');
    expect(temasLineas(got)).toEqual([
      'Sporting: El Sporting ganó el derbi en Oviedo y Gaspar fue el mejor. (El Comercio, LNE)',
      'F1: Alonso acabó tercero en Brasil. (Marca)',
    ]);
    const composed = await composeDailyBriefing(briefingDeps(got));
    expect(composed.text).toContain('Sporting: El Sporting ganó el derbi en Oviedo');
  });

  it('sin modelo barato, o si falla o tarda: los titulares de siempre', async () => {
    expect(temasLineas(await resumirTemas(cards, undefined))).toEqual([
      'Sporting: El Sporting gana en Oviedo (El Comercio)',
      'Sporting: Gaspar, MVP del derbi (LNE)',
      'F1: Alonso, tercero en Brasil (Marca)',
    ]);
    const failed = await resumirTemas(cards, async (p) => {
      if (p.includes('F1')) throw new Error('429');
      return 'El Sporting ganó el derbi en Oviedo.';
    });
    expect(temasLineas(failed)).toEqual([
      'Sporting: El Sporting ganó el derbi en Oviedo. (El Comercio, LNE)',
      'F1: Alonso, tercero en Brasil (Marca)',
    ]);
    const slow = await resumirTemas(cards, () => new Promise(() => {}), 30);
    expect(slow.some((t) => t.resumen)).toBe(false);
  });

  it('limpia lo que dice el modelo', () => {
    expect(limpiaResumen('Resumen: "Alonso fue tercero en Brasil"')).toBe(
      'Alonso fue tercero en Brasil',
    );
    expect(limpiaResumen('No puedo acceder a noticias en tiempo real.')).toBeNull();
    expect(limpiaResumen('ok')).toBeNull();
    const long = limpiaResumen('palabra '.repeat(60));
    expect(Array.from(long ?? '').length).toBeLessThanOrEqual(RESUMEN_TEMA_MAX);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('un botón-enlace por noticia, que Telegram pinta como URL', () => {
    const buttons = temasBotones(cards);
    expect(buttons[0]).toEqual({
      label: '📰 Sporting · El Comercio',
      action: 'url:https://news.google.com/a1',
    });
    expect(usableButtons(buttons)).toHaveLength(3);
    const kb = buildKeyboard(buttons).inline_keyboard.flat();
    expect(kb[0]).toMatchObject({
      text: '📰 Sporting · El Comercio',
      url: 'https://news.google.com/a1',
    });
    // Un callback normal sigue igual y una «url:» que no es https se descarta.
    expect(usableButtons([{ label: 'x', action: 'url:javascript:alert(1)' }])).toEqual([]);
    expect(
      buildKeyboard([{ label: 'Sí', action: 'ok:1' }]).inline_keyboard.flat()[0],
    ).toMatchObject({ callback_data: 'ok:1' });
  });

  it('el resumen de la mañana lleva los botones de sus noticias', async () => {
    const got = await composeDailyBriefing(briefingDeps(cards));
    expect(got.buttons?.map((b) => b.action)).toEqual([
      'url:https://news.google.com/a1',
      'url:https://news.google.com/a2',
      'url:https://news.google.com/b1',
    ]);
  });
});
