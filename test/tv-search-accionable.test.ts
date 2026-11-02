/**
 * action=search devuelve una lista accionable: cada resultado con su appId/id
 * listo para abrirlo con action=launch (vía 2 del orden de búsqueda de #1909),
 * en vez de un JSON crudo de 4000 caracteres que el modelo tenía que parsear.
 * Si no hay nada reconocible, mantiene el crudo y apunta a las otras vías.
 */
import { describe, expect, it } from 'vitest';
import { createTvTool, type TvToolDeps } from '../src/tools/tv.js';
import { collectTvSearchItems, formatTvSearchResults } from '../src/tv/search-results.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200, 7)]);

function deps(over: Partial<TvToolDeps> = {}): TvToolDeps {
  return {
    shot: async () => ({ image: JPEG, mimeType: 'image/jpeg' }),
    foreground: async () => ({ appId: 'netflix', category: [] }),
    apps: async () => [],
    launch: async () => {},
    key: async () => {},
    toast: async () => {},
    power: async () => {},
    saveFrame: () => '/tmp/tv-1.jpg',
    getState: () => null,
    setState: () => {},
    ...over,
  };
}

describe('collectTvSearchItems', () => {
  it('extrae título, appId e id de la forma típica de unifiedsearch', () => {
    const raw = {
      returnValue: true,
      results: [
        { title: 'Ceuta - Sporting', appId: 'org.webosbrew.youtube.adfree', id: 'abc123' },
        { title: 'Resumen jornada 10', launchPointId: 'netflix' },
      ],
    };
    expect(collectTvSearchItems(raw)).toEqual([
      {
        title: 'Ceuta - Sporting',
        appId: 'org.webosbrew.youtube.adfree',
        id: 'abc123',
        target: undefined,
      },
      { title: 'Resumen jornada 10', appId: 'netflix', id: undefined, target: undefined },
    ]);
  });

  it('tolera name/label, objetos anidados y duplicados; corta en 8', () => {
    const raw = {
      data: {
        items: Array.from({ length: 10 }, (_, i) => ({ name: `Vídeo ${i}`, contentId: `c${i}` })),
      },
    };
    const items = collectTvSearchItems(raw);
    expect(items).toHaveLength(8);
    expect(items[0]).toMatchObject({ title: 'Vídeo 0', id: 'c0' });
    const dup = collectTvSearchItems([
      { title: 'A', appId: 'x' },
      { title: 'A', appId: 'x' },
    ]);
    expect(dup).toHaveLength(1);
  });

  it('devuelve vacío con respuestas sin títulos', () => {
    expect(collectTvSearchItems({ returnValue: true, results: [] })).toEqual([]);
    expect(collectTvSearchItems('cualquier cosa')).toEqual([]);
    expect(collectTvSearchItems(null)).toEqual([]);
  });
});

describe('forma real de unifiedsearch (docs webOS LS2)', () => {
  // Respuesta documentada de luna-send com.webos.service.unifiedsearch/search:
  // el título vive en display.title y lo lanzable en el hermano intent
  // (name = appId, o uri = app://<appId>/<ruta>).
  const REAL = {
    results: [
      {
        items: [
          {
            intent: {
              action: 'view',
              uri: 'app://com.webos.app.avn.settings/Settings/Profiles',
            },
            display: { title: 'Profiles', icon: '/usr/palm/x.png' },
          },
        ],
        categoryId: 'com.webos.app.avn.settings',
      },
      {
        items: [
          {
            intent: { name: 'com.webos.app.androidauto' },
            display: { title: 'Android Auto Projection' },
          },
        ],
        categoryId: 'sam.apps',
      },
    ],
    returnValue: true,
  };

  it('saca título de display y appId/target del intent hermano', () => {
    expect(collectTvSearchItems(REAL)).toEqual([
      {
        title: 'Profiles',
        appId: 'com.webos.app.avn.settings',
        id: undefined,
        target: 'app://com.webos.app.avn.settings/Settings/Profiles',
      },
      {
        title: 'Android Auto Projection',
        appId: 'com.webos.app.androidauto',
        id: undefined,
        target: undefined,
      },
    ]);
  });

  it('la lista formateada lleva los appId listos para launch', () => {
    const out = formatTvSearchResults('pro', REAL);
    expect(out).toContain('1. Profiles (appId=com.webos.app.avn.settings)');
    expect(out).toContain('2. Android Auto Projection (appId=com.webos.app.androidauto)');
  });
});

describe('formatTvSearchResults', () => {
  it('lista numerada con appId/id y la orden de abrir con launch', () => {
    const out = formatTvSearchResults('ceuta sporting', {
      results: [{ title: 'Ceuta - Sporting', appId: 'org.webosbrew.youtube.adfree', id: 'abc123' }],
    });
    expect(out).toContain('1. Ceuta - Sporting (appId=org.webosbrew.youtube.adfree, id=abc123)');
    expect(out).toContain('action=launch');
    expect(out).toContain('SIN PREGUNTAR');
  });

  it('sin resultados reconocibles mantiene el crudo y apunta a las otras vías', () => {
    const out = formatTvSearchResults('xyz', { returnValue: true, results: [] });
    expect(out).toContain('sin resultados reconocibles');
    expect(out).toContain('SIN PREGUNTAR');
  });
});

describe('action=search del tool', () => {
  it('usa la lista accionable en la respuesta', async () => {
    const tool = createTvTool(
      deps({
        search: async () => ({
          results: [
            { title: 'Ceuta - Sporting', appId: 'org.webosbrew.youtube.adfree', id: 'abc123' },
          ],
        }),
      }),
    );
    const r = (await tool.execute('t', { action: 'search', text: 'ceuta sporting' })) as {
      content: Array<{ text: string }>;
    };
    expect(r.content[0]?.text).toContain('1. Ceuta - Sporting');
    expect(r.content[0]?.text).toContain('appId=org.webosbrew.youtube.adfree');
  });
});
