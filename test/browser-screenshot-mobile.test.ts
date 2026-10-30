import { describe, expect, it } from 'vitest';
import { MOBILE_VIEWPORT, screenshotPage } from '../src/browser/service.js';
import { createBrowserTool } from '../src/tools/browser.js';

/** Página falsa: apunta los tamaños por los que pasa y en cuál se hizo la captura. */
function fakePage(start: { width: number; height: number } | null, fail = false) {
  let size = start;
  const sizes: string[] = [];
  return {
    sizes,
    shotAt: [] as string[],
    viewportSize: () => size,
    async setViewportSize(s: { width: number; height: number }) {
      size = s;
      sizes.push(`${s.width}x${s.height}`);
    },
    async screenshot() {
      this.shotAt.push(size ? `${size.width}x${size.height}` : 'ventana');
      if (fail) throw new Error('captura rota');
      return Buffer.from('png');
    },
  };
}

describe('captura en vista de móvil', () => {
  it('captura a ancho de móvil y deja la página como estaba', async () => {
    const page = fakePage({ width: 1440, height: 900 });
    const r = await screenshotPage(page, false, true);
    expect(r.mobile).toBe(true);
    expect(page.shotAt).toEqual([`${MOBILE_VIEWPORT.width}x${MOBILE_VIEWPORT.height}`]);
    expect(page.sizes).toEqual(['390x844', '1440x900']);
  });

  it('si la captura falla también devuelve el tamaño de antes', async () => {
    const page = fakePage({ width: 1440, height: 900 }, true);
    await expect(screenshotPage(page, false, true)).rejects.toThrow('captura rota');
    expect(page.sizes.at(-1)).toBe('1440x900');
  });

  it('sin mobile, o con ventana visible sin tamaño fijo, no toca nada', async () => {
    const normal = fakePage({ width: 1440, height: 900 });
    expect((await screenshotPage(normal, false, false)).mobile).toBe(false);
    const ventana = fakePage(null);
    expect((await screenshotPage(ventana, false, true)).mobile).toBe(false);
    expect([...normal.sizes, ...ventana.sizes]).toEqual([]);
  });

  it('la herramienta browser pasa mobile y lo dice en el resultado', async () => {
    const calls: unknown[] = [];
    const service = {
      screenshot: async (_s: string, _f: boolean, opts?: { mobile?: boolean }) => {
        calls.push(opts);
        return { mimeType: 'image/png', data: 'cG5n', mobile: opts?.mobile === true };
      },
    };
    const tool = createBrowserTool(service as never, () => 'chat');
    const res = await tool.execute('id', { action: 'screenshot', mobile: true } as never);
    expect(calls).toEqual([{ mobile: true }]);
    expect((res.content[0] as { text: string }).text).toContain('390×844');
  });
});
