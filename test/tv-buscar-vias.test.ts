/**
 * Bug 2 nov 2026 (Nico): «busca X en YouTube de la tele» acabó con Asistenta
 * atascada en el teclado en pantalla (type no entra en el teclado propio de
 * YouTube) y preguntando «¿lo buscas tú o prefieres A o B?». La guía del tool
 * manda ahora: search (invisible) primero, launch con contentId si se sabe el
 * título, teclado de la app como ÚLTIMA vía y, si una vía falla, probar la
 * siguiente SIN preguntar. El error de type apunta a las otras vías, no a
 * reintentos en bucle.
 */
import { describe, expect, it } from 'vitest';
import { createTvTool, type TvToolDeps } from '../src/tools/tv.js';

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

describe('buscar en la tele: orden de vías y no preguntar', () => {
  it('la guía del tool pone search antes que el teclado y prohíbe devolver la tarea', () => {
    const desc = (createTvTool(deps()) as unknown as { description: string }).description;
    const iSearch = desc.indexOf('action=search');
    const iType = desc.indexOf('teclado propio');
    expect(iSearch).toBeGreaterThan(-1);
    expect(iType).toBeGreaterThan(-1);
    // search se menciona como primera vía del bloque de búsqueda de contenido.
    const bloque = desc.slice(desc.indexOf('Para buscar contenido'));
    expect(bloque.indexOf('action=search')).toBeLessThan(bloque.indexOf('screenshot'));
    // Regla: si una vía falla, probar la siguiente sin preguntar.
    expect(desc).toContain('SIN PREGUNTAR');
    expect(desc).toContain('nunca devuelvas la tarea');
    // YouTube con teclado propio: type puede no entrar; cambiar de vía.
    expect(desc).toContain('no reintentes type');
  });

  it('el error de type apunta a las otras vías y corta el bucle de reintentos', async () => {
    const tool = createTvTool(
      deps({
        typeText: async () => {
          throw new Error('insertText: no hay campo');
        },
      }),
    );
    const err = await tool
      .execute('t', { action: 'type', text: 'ceuta sporting', look: false })
      .then(() => null)
      .catch((e: unknown) => e);
    const msg = String((err as Error).message);
    expect(msg).toContain('reintenta UNA vez');
    expect(msg).toContain('action=search');
    expect(msg).toContain('contentId');
  });
});
