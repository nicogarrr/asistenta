import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandejaCommand, bandejaSlowSub } from '../src/bandeja/comando.js';
import { BandejaQueue } from '../src/bandeja/procesar.js';
import { pendientesDeReleer, releerTodo } from '../src/bandeja/releer.js';
import { BandejaStore } from '../src/bandeja/store.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';

const CHAT = '111';
const NOV11 = new Date('2026-11-11T15:00:00Z');
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const EVENTO_HTML = `<html><head>${ld({
  '@type': 'Event',
  name: 'Junta General 2026',
  startDate: '2026-12-02T12:00:00+01:00',
  location: 'Madrid',
})}</head><body>x</body></html>`;
const RECETA_HTML = `<html><head>${ld({
  '@type': 'Recipe',
  name: 'Tortilla',
  recipeIngredient: ['4 huevos', '500 g de patatas', '1 cebolla'],
})}</head><body>x</body></html>`;
const NADA_HTML = '<html><body>un post</body></html>';

let dir = '';
let store: BandejaStore;
const prevTz = process.env.PA_TIMEZONE;
beforeEach(() => {
  process.env.PA_TIMEZONE = 'Europe/Madrid';
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps15-releer-todo-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  if (prevTz === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = prevTz;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function vieja(url: string, when = new Date('2026-11-01T10:00:00Z'), kind = 'enlace' as const) {
  const { item } = store.add(CHAT, { kind, url }, when, '2026-11-01');
  store.saveResult(
    item.id,
    {
      title: `Página ${url.split('/').pop()}`,
      verdict: 'ideas',
      score: 6,
      reason: 'x',
      ideas: [],
      costMin: 2,
      costLabel: '📰 ~2 min de lectura',
      extra: { source: 'x.example', basis: 'texto' },
    },
    when,
  );
  return item.id;
}

const PAGES: Record<string, string> = {
  'https://a.example/junta': EVENTO_HTML,
  'https://a.example/tortilla': RECETA_HTML,
  'https://a.example/post': NADA_HTML,
};
const fetchOk = async (url: string) => {
  const h = PAGES[url];
  if (!h) throw new Error('HTTP 404');
  return h;
};

const deps = (
  fetchPagina: (url: string) => Promise<string>,
  progress?: (t: string) => Promise<unknown>,
) => ({
  store,
  queue: new BandejaQueue(store, {
    complete: async () => async () => '',
    fetchRaw: async () => '',
    videoText: async () => ({ ok: false as const, reason: 'no' }),
  }),
  chatId: CHAT,
  now: () => NOV11,
  timeZone: () => 'Europe/Madrid',
  fetchPagina,
  sleep: async () => undefined,
  ...(progress ? { progress } : {}),
});

describe('gaps-15: «/bandeja releer todo» (lo guardado antes, de una en una)', () => {
  it('es una orden lenta (va aparte, no bloquea Telegram)', () => {
    expect(bandejaSlowSub('releer todo')).toBe(true);
  });

  it('relee las de los últimos 30 días, dice qué traen y da sus botones', async () => {
    const junta = vieja('https://a.example/junta');
    const tortilla = vieja('https://a.example/tortilla');
    vieja('https://a.example/post');
    vieja('https://a.example/rota');
    vieja('https://a.example/vieja-de-octubre', new Date('2026-09-01T10:00:00Z'));
    const avisos: string[] = [];
    const urls: string[] = [];
    const r = await bandejaCommand(
      'releer todo',
      deps(
        async (u) => {
          urls.push(u);
          return fetchOk(u);
        },
        async (t) => avisos.push(t),
      ),
    );
    expect(urls).not.toContain('https://a.example/vieja-de-octubre');
    expect(urls).toHaveLength(4);
    expect(avisos[0]).toMatch(/^🔄 Releo 4 páginas de una en una/);
    expect(r.text).toContain('🔄 Releídas 3 páginas: 2 con algo nuevo.');
    expect(r.text).toContain(`#${junta} `);
    expect(r.text).toContain(`#${tortilla} `);
    expect(r.text).toContain('⚠️ 1 no abrió');
    const cmds = (r.buttons ?? []).map((b) => commandFromCallback(b.action));
    expect(cmds.sort()).toEqual([`/bandeja calendario ${junta}`, `/bandeja compra ${tortilla}`]);
    // La segunda vez solo vuelve a probar la que no abrió.
    const otra: string[] = [];
    await bandejaCommand(
      'releer todo',
      deps(async (u) => {
        otra.push(u);
        return fetchOk(u);
      }),
    );
    expect(otra).toEqual(['https://a.example/rota']);
  });

  it('«releer todo 90» mira más atrás (tope 90 días)', async () => {
    vieja('https://a.example/post', new Date('2026-09-01T10:00:00Z'));
    expect(pendientesDeReleer(store, CHAT, NOV11)).toHaveLength(0);
    const r = await bandejaCommand('releer todo 90', deps(fetchOk));
    expect(r.text).toContain('🔄 Releídas 1 página: ninguna trae receta ni evento nuevos.');
  });

  it('con pausa entre páginas, tope por vez, y dice cuántas quedan', async () => {
    for (let i = 0; i < 5; i++) vieja(`https://a.example/p${i}`);
    const pausas: number[] = [];
    const r = await releerTodo(store, CHAT, async () => NADA_HTML, {
      now: NOV11,
      max: 3,
      pausaMs: 3000,
      sleep: async (ms) => {
        pausas.push(ms);
      },
    });
    if (r === 'ocupado') throw new Error('ocupado');
    expect(pausas).toEqual([3000, 3000]);
    expect(r.igual).toBe(3);
    expect(r.quedan).toBe(2);
  });

  it('una sola pasada a la vez por chat', async () => {
    vieja('https://a.example/post');
    let suelta: () => void = () => undefined;
    const lenta = new Promise<string>((res) => {
      suelta = () => res(NADA_HTML);
    });
    const primera = releerTodo(store, CHAT, () => lenta, { now: NOV11, pausaMs: 0 });
    const r = await bandejaCommand('releer todo', deps(fetchOk));
    expect(r.text).toContain('Ya estoy releyendo');
    suelta();
    await primera;
  });

  it('nada que releer lo dice', async () => {
    const r = await bandejaCommand('releer todo', deps(fetchOk));
    expect(r.text).toMatch(/^🔄 Nada que releer de los últimos 30 días/);
  });

  it('«/bandeja releer N» también la marca: «releer todo» no la repite', async () => {
    const id = vieja('https://a.example/post');
    await bandejaCommand(`releer ${id}`, deps(fetchOk));
    expect(pendientesDeReleer(store, CHAT, NOV11)).toHaveLength(0);
  });
});
