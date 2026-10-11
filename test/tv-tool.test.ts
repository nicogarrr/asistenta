import { describe, expect, it } from 'vitest';
import { createTvTool } from '../src/tools/tv.js';
import type { TvMemoryState, TvToolDeps } from '../src/tools/tv.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200, 7)]);
const BLANK = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(300)]);

function deps(over: Partial<TvToolDeps> = {}): { deps: TvToolDeps; calls: string[]; state: { v: TvMemoryState | null } } {
  const calls: string[] = [];
  const state = { v: null as TvMemoryState | null };
  const d: TvToolDeps = {
    shot: async () => {
      calls.push('shot');
      return { image: JPEG, mimeType: 'image/jpeg' };
    },
    foreground: async () => {
      calls.push('foreground');
      return { appId: 'netflix', category: [] };
    },
    apps: async () => [
      { id: 'org.webosbrew.hbchannel', title: 'Homebrew Channel' },
      { id: 'netflix', title: 'Netflix' },
    ],
    launch: async (id) => void calls.push(`launch:${id}`),
    key: async (n) => void calls.push(`key:${n}`),
    toast: async (m) => void calls.push(`toast:${m}`),
    power: async (on) => void calls.push(`power:${on}`),
    saveFrame: (bytes) => {
      calls.push(`save:${bytes.length}`);
      return 'C:/state/screenshots/tv/tv-1.jpg';
    },
    getState: () => state.v,
    setState: (s) => {
      calls.push('setState');
      state.v = s;
    },
    ...over,
  };
  return { deps: d, calls, state };
}

type ToolResult = {
  content: ({ type: string; text?: string } | { type: string; data: string })[];
  details: Record<string, unknown>;
};

const textOf = (content: ToolResult['content']): string =>
  content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join(' ');

const run = (d: TvToolDeps, args: Record<string, unknown>) =>
  createTvTool(d).execute('id', args as never) as unknown as Promise<ToolResult>;

const exec = (d: TvToolDeps, args: Record<string, unknown>) =>
  createTvTool(d).execute('id', args as never);

describe('createTvTool', () => {
  it('screenshot devuelve la imagen al modelo y recuerda el estado', async () => {
    const { deps: d, calls, state } = deps();
    const out = await run(d, { action: 'screenshot' });

    const img = out.content.find((c) => c.type === 'image');
    expect(img).toBeDefined();
    // base64 puro, sin prefijo data: (lo pone el provider, no la tool)
    expect((img as { data: string }).data).toBe(JPEG.toString('base64'));

    expect(textOf(out.content)).toContain('netflix');
    // La foto se guarda y el estado queda disponible para action=state
    expect(calls).toContain('save:203');
    expect(state.v?.appId).toBe('netflix');
  });

  it('avisa de frame casi vacio sin decir que la tele este apagada', async () => {
    const { deps: d } = deps({
      shot: async () => ({ image: BLANK, mimeType: 'image/jpeg' }),
    });
    const out = await run(d, { action: 'screenshot' });
    // El texto debe senalar DRM, no "pantalla apagada": confundirlos lleva al
    // modelo a apagar o encender una tele que esta reproduciendo.
    expect(textOf(out.content)).toMatch(/DRM/);
    expect(textOf(out.content)).not.toMatch(/apagada/i);
    expect(out.details.blank).toBe(true);
  });

  it('state responde sin tocar la tele cuando no hay memoria', async () => {
    const { deps: d, calls } = deps();
    const out = await run(d, { action: 'state' });
    expect(out.details.known).toBe(false);
    expect(calls).toEqual([]);
  });

  it('state recuerda la ultima mirada sin despertar la tele', async () => {
    const { deps: d, state, calls } = deps();
    state.v = { appId: 'org.xbmc.kodi', category: [], at: '2026-10-11T10:00:00.000Z', framePath: '/x.jpg', bytes: 10 };
    const out = await run(d, { action: 'state' });
    expect(out.details.known).toBe(true);
    expect(textOf(out.content)).toContain('org.xbmc.kodi');
    // Ni shot ni foreground: el recuerdo no consulta la tele
    expect(calls).toEqual([]);
  });

  it('apps lista ids y titulos', async () => {
    const { deps: d } = deps();
    const out = await run(d, { action: 'apps' });
    expect(textOf(out.content)).toContain('org.webosbrew.hbchannel');
    expect(out.details.count).toBe(2);
  });

  it('launch exige appId y key exige un nombre conocido', async () => {
    const { deps: d, calls } = deps();
await expect(exec(d, { action: 'launch' })).rejects.toThrow(/appId/);
    await expect(exec(d, { action: 'key', name: 'RAKETA' })).rejects.toThrow(/valido/);
    expect(calls).toEqual([]);
  });

  it('key en mayusculas pasa el nombre al socket', async () => {
    const { deps: d, calls } = deps();
    await exec(d, { action: 'key', name: 'home' });
    expect(calls).toEqual(['key:HOME']);
  });
});

