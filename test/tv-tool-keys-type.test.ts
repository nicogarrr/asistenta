/**
 * Tool `tv`: acción key con ráfaga (names) y acción type nueva. La ráfaga usa
 * el atajo tvKeys cuando el plugin lo ofrece (deps.keys) y cae al bucle de
 * siempre si no; type escribe en el campo enfocado vía deps.typeText.
 */
import { describe, expect, it } from 'vitest';
import type { TvToolDeps } from '../src/tools/tv.js';
import { createTvTool } from '../src/tools/tv.js';

function toolDeps(over: Partial<TvToolDeps> = {}) {
  const calls: unknown[][] = [];
  const d: TvToolDeps = {
    shot: async () => ({ image: Buffer.alloc(30_000, 1), mimeType: 'image/jpeg' }),
    foreground: async () => ({ appId: 'netflix', category: [] }),
    apps: async () => [{ id: 'netflix', title: 'Netflix' }],
    launch: async (...a) => void calls.push(['launch', ...a]),
    key: async (...a) => void calls.push(['key', ...a]),
    toast: async (...a) => void calls.push(['toast', ...a]),
    power: async (...a) => void calls.push(['power', ...a]),
    saveFrame: () => '/tmp/tv.jpg',
    getState: () => null,
    setState: () => {},
    ...over,
  };
  return { d, calls };
}

type R = { content: Array<{ type: string; text?: string }>; details: Record<string, unknown> };
const run = (d: TvToolDeps, args: Record<string, unknown>) =>
  createTvTool(d).execute('id', args as never) as unknown as Promise<R>;
const text = (r: R) => r.content.map((c) => c.text ?? '').join(' ');

describe('tool tv: ráfaga de teclas (key con names)', () => {
  it('usa el atajo deps.keys una sola vez con la lista traducida', async () => {
    const keysCalls: string[][] = [];
    const { d, calls } = toolDeps({
      keys: async (names) => void keysCalls.push(names),
    });
    const r = await run(d, { action: 'key', names: ['volup', 'enter', 'back'] });
    expect(keysCalls).toEqual([['VOLUMEUP', 'ENTER', 'BACK']]);
    expect(calls).toEqual([]); // no pasa por el camino tecla a tecla
    expect(text(r)).toMatch(/teclas seguidas/);
  });

  it('sin deps.keys cae al bucle clásico tecla a tecla', async () => {
    const { d, calls } = toolDeps();
    await run(d, { action: 'key', names: ['down', 'down', 'enter'] });
    expect(calls).toEqual([
      ['key', 'DOWN'],
      ['key', 'DOWN'],
      ['key', 'ENTER'],
    ]);
  });

  it('una sola tecla en names funciona como name', async () => {
    const { d, calls } = toolDeps();
    await run(d, { action: 'key', names: ['home'] });
    expect(calls).toEqual([['key', 'HOME']]);
  });

  it('tecla ilegal en la lista se rechaza antes de tocar la tele', async () => {
    const keysCalls: string[][] = [];
    const { d, calls } = toolDeps({
      keys: async (names) => void keysCalls.push(names),
    });
    await expect(run(d, { action: 'key', names: ['ok', 'apagarTodo'] })).rejects.toThrow(
      /nombres validos/,
    );
    expect(keysCalls).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('sin name ni names devuelve el error de siempre', async () => {
    const { d } = toolDeps();
    await expect(run(d, { action: 'key' })).rejects.toThrow(/necesita un nombre valido/);
  });
});

describe('tool tv: type (escribir en el campo enfocado)', () => {
  it('envía el texto a deps.typeText', async () => {
    const typed: string[] = [];
    const { d } = toolDeps({
      typeText: async (t) => void typed.push(t),
    });
    const r = await run(d, { action: 'type', text: 'el padrino' });
    expect(typed).toEqual(['el padrino']);
    expect(text(r)).toMatch(/He escrito/);
  });

  it('sin deps.typeText avisa de que la tele no lo soporta', async () => {
    const { d } = toolDeps();
    await expect(run(d, { action: 'type', text: 'hola' })).rejects.toThrow(/no sabe escribir/);
  });

  it('necesita text', async () => {
    const { d } = toolDeps({ typeText: async () => {} });
    await expect(run(d, { action: 'type' })).rejects.toThrow(/necesita text/);
  });

  it('si la tele rechaza, explica que hace falta un campo enfocado', async () => {
    const { d } = toolDeps({
      typeText: async () => {
        throw new Error('no focused field');
      },
    });
    await expect(run(d, { action: 'type', text: 'hola' })).rejects.toThrow(/buscador/);
  });
});
