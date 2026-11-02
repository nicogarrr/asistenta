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

describe('tool tv: look (captura tras la acción)', () => {
  const images = (r: R) => r.content.filter((c) => (c as { type: string }).type === 'image');

  it('la ráfaga devuelve captura por defecto y guarda el estado', async () => {
    let saved: unknown = null;
    const { d } = toolDeps({
      setState: (st) => {
        saved = st;
      },
    });
    const r = await run(d, { action: 'key', names: ['down', 'enter'] });
    expect(images(r)).toHaveLength(1);
    expect(saved).toMatchObject({ appId: 'netflix', framePath: '/tmp/tv.jpg' });
    expect(text(r)).toMatch(/teclas seguidas/);
    expect(text(r)).toMatch(/Captura tras la acción: app netflix/);
  });

  it('la ráfaga con look:false no captura', async () => {
    let shots = 0;
    const { d } = toolDeps({
      shot: async () => {
        shots += 1;
        return { image: Buffer.alloc(30_000, 1), mimeType: 'image/jpeg' };
      },
    });
    const r = await run(d, { action: 'key', names: ['down', 'enter'], look: false });
    expect(shots).toBe(0);
    expect(images(r)).toHaveLength(0);
  });

  it('una tecla suelta no captura por defecto; look:true la adjunta', async () => {
    const { d, calls } = toolDeps();
    const sin = await run(d, { action: 'key', name: 'enter' });
    expect(images(sin)).toHaveLength(0);
    const con = await run(d, { action: 'key', name: 'enter', look: true });
    expect(images(con)).toHaveLength(1);
    expect(calls).toEqual([
      ['key', 'ENTER'],
      ['key', 'ENTER'],
    ]);
  });

  it('type devuelve captura por defecto y look:false la quita', async () => {
    const { d } = toolDeps({ typeText: async () => {} });
    const con = await run(d, { action: 'type', text: 'ceuta sporting' });
    expect(images(con)).toHaveLength(1);
    const sin = await run(d, { action: 'type', text: 'x', look: false });
    expect(images(sin)).toHaveLength(0);
  });

  it('si la captura falla tras la ráfaga, la acción no se pierde', async () => {
    const { d } = toolDeps({
      shot: async () => {
        throw new Error('captura rota');
      },
    });
    const r = await run(d, { action: 'key', names: ['home'] });
    expect(images(r)).toHaveLength(0);
    expect(text(r)).toMatch(/teclas seguidas/);
    expect(text(r)).toMatch(/No pude capturar/);
  });
});

describe('tool tv: launch con deeplink (contentId)', () => {
  it('con contentId usa deps.launchDeep con el id resuelto y el contenido', async () => {
    const deep: string[][] = [];
    const { d, calls } = toolDeps({
      launchDeep: async (id, contentId) => void deep.push([id, contentId]),
    });
    const r = await run(d, {
      action: 'launch',
      appId: 'netflix',
      contentId: 'm=https://www.netflix.com/watch/80189685',
    });
    expect(deep).toEqual([['netflix', 'm=https://www.netflix.com/watch/80189685']]);
    expect(calls).toEqual([]); // no pasa por el launch normal
    expect(text(r)).toMatch(/directamente en ese contenido/);
  });

  it('sin deps.launchDeep explica la ruta manual', async () => {
    const { d } = toolDeps();
    await expect(
      run(d, { action: 'launch', appId: 'netflix', contentId: 'v=abc' }),
    ).rejects.toThrow(/no sabe abrir deeplinks/);
  });
});

describe('tool tv: search (búsqueda universal webOS)', () => {
  it('devuelve lo que la tele encuentra para el texto', async () => {
    const { d } = toolDeps({
      search: async () => ({
        returnValue: true,
        results: [{ categoryId: 'sam.apps', items: [{ display: { title: 'Movistar Plus+' } }] }],
      }),
    });
    const r = await run(d, { action: 'search', text: 'ceuta sporting' });
    expect(text(r)).toMatch(/Búsqueda universal de la tele para «ceuta sporting»/);
    expect(text(r)).toMatch(/Movistar Plus\+/);
  });

  it('necesita text y avisa si la instalación no lo tiene', async () => {
    const { d } = toolDeps({ search: async () => ({}) });
    await expect(run(d, { action: 'search' })).rejects.toThrow(/necesita text/);
    const bare = toolDeps();
    await expect(run(bare.d, { action: 'search', text: 'x' })).rejects.toThrow(
      /no tiene la búsqueda universal/,
    );
  });
});

describe('tool tv: guide (qué echan en Movistar Plus+)', () => {
  const partido = {
    channelName: 'M+ LALIGA TV',
    title: 'LALIGA HYPERMOTION: Ceuta FC - Real Sporting',
    desc: '',
    start: new Date('2026-11-02T10:30:00Z'),
    stop: new Date('2026-11-02T12:30:00Z'),
    live: true,
  };

  it('devuelve canal y hora en castellano', async () => {
    const { d } = toolDeps({ guide: async () => [partido] });
    const r = await run(d, { action: 'guide', text: 'ceuta sporting' });
    expect(text(r)).toMatch(/Ceuta FC - Real Sporting/);
    expect(text(r)).toMatch(/M\+ LALIGA TV/);
    expect(text(r)).toMatch(/AHORA/);
    expect(text(r)).toMatch(/busca el canal por su nombre/);
    expect(text(r)).toContain('appId=com.telefonica.app.nux');
    expect(text(r)).toContain('SIN PREGUNTAR');
  });

  it('sin resultados lo dice claro', async () => {
    const { d } = toolDeps({ guide: async () => [] });
    const r = await run(d, { action: 'guide', text: 'real madrid' });
    expect(text(r)).toMatch(/No encuentro «real madrid»/);
  });

  it('necesita text y avisa si la instalación no lo tiene', async () => {
    const { d } = toolDeps({ guide: async () => [] });
    await expect(run(d, { action: 'guide' })).rejects.toThrow(/necesita text/);
    const bare = toolDeps();
    await expect(run(bare.d, { action: 'guide', text: 'x' })).rejects.toThrow(
      /no tiene la guía de Movistar/,
    );
  });
});
