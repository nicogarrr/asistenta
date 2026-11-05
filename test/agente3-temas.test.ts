import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBriefing } from '../src/briefing.js';
import { composeDailyBriefing } from '../src/briefing-daily.js';
import {
  createTemasTool,
  noticiasUrl,
  parseRss,
  TemasStore,
  tarjetasDeTemas,
  temasDelPerfil,
} from '../src/noticias-temas.js';

/**
 * El resumen de la mañana no traía nada de lo que Nico sigue (ChatGPT Pulse, Poke sí).
 * Ahora la sección «Tus temas»: titulares de la noche de sus temas, con su fuente, sin
 * repetir y sin gastar tokens (RSS de Google Noticias).
 */
const NOW = Date.parse('2026-11-05T07:00:00Z');
const rss = (items: Array<[string, string, string, string]>) =>
  `<?xml version="1.0"?><rss><channel><title>x</title>${items
    .map(
      ([title, link, source, date]) =>
        `<item><title>${title} - ${source}</title><link>${link}</link><pubDate>${date}</pubDate><source url="https://x">${source}</source></item>`,
    )
    .join('')}</channel></rss>`;

const SPORTING = rss([
  [
    'El Sporting gana 2-0 al Oviedo en El Molinón',
    'https://news.example/a',
    'El Comercio',
    'Wed, 04 Nov 2026 21:30:00 GMT',
  ],
  ['Sporting: lesión de Cote', 'https://news.example/b', 'Marca', 'Thu, 05 Nov 2026 06:00:00 GMT'],
  ['Tercera noticia', 'https://news.example/c', 'AS', 'Thu, 05 Nov 2026 05:00:00 GMT'],
  ['Noticia vieja', 'https://news.example/d', 'AS', 'Sun, 01 Nov 2026 10:00:00 GMT'],
]);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const store = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ag3-temas-'));
  dirs.push(dir);
  return new TemasStore(join(dir, 'temas.json'));
};

describe('Tus temas', () => {
  it('lee el RSS: título sin la fuente al final, enlace, fuente y fecha; con entidades', () => {
    const items = parseRss(
      rss([
        [
          'Ca&amp;ña &quot;x&quot;',
          'https://n/1',
          'La Nueva España',
          'Thu, 05 Nov 2026 06:00:00 GMT',
        ],
      ]),
    );
    expect(items).toEqual([
      {
        titulo: 'Ca&ña "x"',
        url: 'https://n/1',
        fuente: 'La Nueva España',
        at: Date.parse('2026-11-05T06:00:00Z'),
      },
    ]);
    expect(noticiasUrl('Sporting de Gijón')).toBe(
      'https://news.google.com/rss/search?q=Sporting%20de%20Gij%C3%B3n%20when%3A1d&hl=es&gl=ES&ceid=ES:es',
    );
  });

  it('dos tarjetas por tema, de las últimas horas, sin las ya vistas', async () => {
    const s = store();
    s.markSeen(['https://news.example/b']);
    const cards = await tarjetasDeTemas(['Sporting'], async () => SPORTING, s, NOW);
    expect(cards.map((c) => c.titulo)).toEqual([
      'El Sporting gana 2-0 al Oviedo en El Molinón',
      'Tercera noticia',
    ]);
    expect(cards[0]?.fuente).toBe('El Comercio');
  });

  it('un tema que falla se salta; los demás salen', async () => {
    const s = store();
    const cards = await tarjetasDeTemas(
      ['F1', 'Sporting'],
      async (url) => {
        if (url.includes('F1')) throw new Error('sin red');
        return SPORTING;
      },
      s,
      NOW,
    );
    expect(cards.every((c) => c.tema === 'Sporting')).toBe(true);
  });

  it('su equipo apuntado («Soy del Sporting») cuenta como tema', () => {
    expect(
      temasDelPerfil(['[dicho] Soy del Sporting', '[dicho] Soy de Gijón', 'soy del montón']),
    ).toEqual(['Sporting']);
  });

  it('la lista: hasta 5, sin repetir, se guarda y se quita', () => {
    const s = store();
    expect(s.add('Fórmula 1')).toBeNull();
    expect(s.add('formula 1')).toBeNull();
    for (const t of ['a1', 'a2', 'a3', 'a4']) s.add(t);
    expect(s.add('a5')).toContain('Ya sigo 5');
    expect(s.remove('formula')).toEqual(['Fórmula 1']);
    expect(s.list()).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('el resumen de la mañana trae la sección «Tus temas» con la fuente', async () => {
    const text = buildBriefing({
      greeting: 'Buenos días',
      today: new Date(NOW),
      routines: [],
      followups: [],
      reminders: [],
      agenda: [{ title: 'Dentista', when: '10:00' }],
      temas: [
        {
          tema: 'Sporting',
          titulo: 'El Sporting gana 2-0',
          fuente: 'El Comercio',
          url: 'https://x',
        },
      ],
    });
    expect(text).toContain('Tus temas\n- Sporting: El Sporting gana 2-0 (El Comercio)');
    const composed = await composeDailyBriefing({
      enabled: () => true,
      now: () => new Date(NOW),
      lastSent: () => 0,
      markSent: () => {},
      owner: () => '1',
      send: async () => true,
      temas: async () => [{ tema: 'F1', titulo: 'Alonso, segundo', url: 'https://x' }],
    });
    expect(composed.text).toContain('- F1: Alonso, segundo');
    // Solo titulares no justifican mandar el resumen.
    expect(composed.empty).toBe(true);
  });

  it('herramienta: «sígueme el tema de la F1», lista y noticias con enlace', async () => {
    const s = store();
    const tool = createTemasTool({
      store: s,
      temas: () => s.list(),
      news: () => tarjetasDeTemas(s.list(), async () => SPORTING, s, NOW),
    });
    const text = async (args: Record<string, unknown>) => {
      const r = await tool.execute('id', args as never);
      const c = r.content[0];
      return c && c.type === 'text' ? c.text : '';
    };
    expect(await text({ action: 'add', tema: 'Sporting' })).toContain('Sigo «Sporting»');
    expect(await text({ action: 'list' })).toBe('Sigo: Sporting.');
    expect(await text({ action: 'news' })).toContain('https://news.example/a');
    expect(await text({ action: 'remove', tema: 'sporting' })).toBe('Ya no sigo: Sporting.');
  });
});
