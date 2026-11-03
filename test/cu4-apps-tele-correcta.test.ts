/**
 * action=apps lee la lista de la tele correcta (asis-computeruse-4, pista 6
 * de cu3/HANDOFF.md): una Roku/Samsung activa o nombrada («la del
 * dormitorio») da SU lista real; antes siempre se preguntaba a la LG por SSAP.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTvTool, type TvOrderRoute, type TvToolDeps } from '../src/tools/tv.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9000, 7)]);
function fakeDeps(over: Partial<TvToolDeps> = {}): TvToolDeps {
  return {
    shot: async () => ({ image: JPEG, mimeType: 'image/jpeg' }),
    foreground: async () => ({ appId: 'netflix', category: [] }),
    apps: vi.fn(async () => [{ id: 'netflix', title: 'Netflix' }]),
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
const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.map((c) => c.text ?? '').join(' ');
const direct = <T>(fn: () => Promise<T>) => fn();

describe('action=apps con varias teles', () => {
  it('Samsung nombrada: su lista real, sin tocar la LG', async () => {
    const samsungApps = vi.fn(async () => [
      { id: '593099', title: 'RTVE Play' },
      { id: '3201907018807', title: 'Netflix' },
    ]);
    const lgApps = vi.fn(async () => []);
    const routeOrder = vi.fn(
      async (t: string): Promise<TvOrderRoute> => ({
        text: t,
        label: 'Dormitorio',
        run: direct,
        intentRunner: async () => 'ok',
        apps: samsungApps,
      }),
    );
    const tool = createTvTool(fakeDeps({ routeOrder, apps: lgApps }));
    const res = await tool.execute('t', { action: 'apps', text: 'la del dormitorio' });
    expect(routeOrder).toHaveBeenCalledWith('la del dormitorio');
    expect(samsungApps).toHaveBeenCalledTimes(1);
    expect(lgApps).not.toHaveBeenCalled();
    expect(text(res)).toContain('RTVE Play');
    expect(text(res)).toContain('(tele: Dormitorio)');
    expect(res.details).toMatchObject({ count: 2, tv: 'Dormitorio' });
  });

  it('Roku/Samsung activa sin nombrarla: también su lista (routeOrder con texto vacío)', async () => {
    const rokuApps = vi.fn(async () => [{ id: '837', title: 'YouTube' }]);
    const routeOrder = vi.fn(
      async (t: string): Promise<TvOrderRoute> => ({
        text: t,
        run: direct,
        intentRunner: async () => 'ok',
        apps: rokuApps,
      }),
    );
    const tool = createTvTool(fakeDeps({ routeOrder }));
    const res = await tool.execute('t', { action: 'apps' });
    expect(routeOrder).toHaveBeenCalledWith('');
    expect(text(res)).toContain('837\tYouTube');
  });

  it('LG (activa o nombrada): la de siempre, dentro del contexto de esa tele', async () => {
    let runs = 0;
    const run = <T>(fn: () => Promise<T>) => {
      runs++;
      return fn();
    };
    const routeOrder = vi.fn(
      async (t: string): Promise<TvOrderRoute> => ({ text: t, label: 'Salón', run }),
    );
    const deps = fakeDeps({ routeOrder });
    const tool = createTvTool(deps);
    const res = await tool.execute('t', { action: 'apps', text: 'la del salón' });
    expect(runs).toBe(1);
    expect(deps.apps).toHaveBeenCalledTimes(1);
    expect(text(res)).toContain('netflix\tNetflix');
  });

  it('si no está claro qué tele, pregunta sin pedir nada a ninguna', async () => {
    const deps = fakeDeps({
      routeOrder: async (t) => ({
        text: t,
        ask: '¿La del salón o la del dormitorio?',
        run: direct,
      }),
    });
    const res = await createTvTool(deps).execute('t', { action: 'apps', text: 'la tele' });
    expect(text(res)).toContain('¿La del salón o la del dormitorio?');
    expect(deps.apps).not.toHaveBeenCalled();
  });

  it('una marca sin lista lo dice claro (no pregunta a la LG por error)', async () => {
    const deps = fakeDeps({
      routeOrder: async (t) => ({ text: t, run: direct, intentRunner: async () => 'ok' }),
    });
    await expect(createTvTool(deps).execute('t', { action: 'apps' })).rejects.toThrow(
      /no deja leer su lista/,
    );
    expect(deps.apps).not.toHaveBeenCalled();
  });

  it('sin varias teles (sin routeOrder): igual que antes', async () => {
    const deps = fakeDeps();
    const res = await createTvTool(deps).execute('t', { action: 'apps' });
    expect(text(res)).toBe('netflix\tNetflix');
  });
});
