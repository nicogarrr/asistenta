import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bandejaCommand, bandejaSlowSub } from '../src/bandeja/comando.js';
import { cardButtons } from '../src/bandeja/formato.js';
import { BandejaQueue } from '../src/bandeja/procesar.js';
import { fichasDe } from '../src/bandeja/releer.js';
import { BandejaStore } from '../src/bandeja/store.js';
import { commandFromCallback } from '../src/channels/telegram-shared.js';

const CHAT = '111';
const NOV11 = new Date('2026-11-11T15:00:00Z');
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const EVENTO_HTML = `<html><head>${ld({
  '@type': 'Event',
  name: 'Junta General de Accionistas 2026',
  startDate: '2026-12-02T12:00:00+01:00',
  location: 'Madrid',
})}</head><body>x</body></html>`;
const RECETA_HTML = `<html><head>${ld({
  '@type': 'Recipe',
  name: 'Tortilla',
  recipeIngredient: ['4 huevos', '500 g de patatas', '1 cebolla'],
})}</head><body>x</body></html>`;

let dir = '';
let store: BandejaStore;
const prevTz = process.env.PA_TIMEZONE;
beforeEach(() => {
  process.env.PA_TIMEZONE = 'Europe/Madrid';
  dir = mkdtempSync(join(tmpdir(), 'pa-gaps14-releer-'));
  store = new BandejaStore(join(dir, 'bandeja.db'));
});
afterEach(() => {
  if (prevTz === undefined) delete process.env.PA_TIMEZONE;
  else process.env.PA_TIMEZONE = prevTz;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Una cosa vieja: juzgada antes de que existieran 🛒/📅, sin `extra.receta`/`extra.evento`. */
function vieja(url = 'https://junta.example/2026') {
  const { item } = store.add(CHAT, { kind: 'enlace', url }, NOV11, '2026-11-01');
  store.saveResult(
    item.id,
    {
      title: 'Junta 2026',
      verdict: 'ideas',
      score: 6,
      reason: 'Orden del día interesante.',
      ideas: ['dividendo'],
      costMin: 2,
      costLabel: '📰 ~2 min de lectura',
      extra: { source: 'junta.example', basis: 'texto', tags: ['bolsa'] },
    },
    NOV11,
  );
  const it = store.get(item.id);
  if (!it) throw new Error('sin cosa');
  return it;
}

const deps = (fetchPagina?: (url: string) => Promise<string>) => ({
  store,
  queue: new BandejaQueue(store, {
    complete: async () => async () => '',
    fetchRaw: async () => '',
    videoText: async () => ({ ok: false as const, reason: 'no' }),
  }),
  chatId: CHAT,
  now: () => NOV11,
  timeZone: () => 'Europe/Madrid',
  ...(fetchPagina ? { fetchPagina } : {}),
});

describe('gaps-14: «🔄 Releer la página» para lo guardado antes de 🛒/📅', () => {
  it('fichasDe lee receta y evento; nada si no es HTML', () => {
    expect(fichasDe(RECETA_HTML)).toEqual({ receta: 3 });
    expect(fichasDe(EVENTO_HTML).evento?.nombre).toBe('Junta General de Accionistas 2026');
    expect(fichasDe('%PDF-1.4')).toEqual({});
  });

  it('una cosa vieja de un evento: antes sin 📅; tras releer, con 📅 y su fecha, sin tocar la nota', async () => {
    const it0 = vieja();
    expect(cardButtons(it0).some((b) => b.label === '📅 Al calendario')).toBe(false);
    const pedidas: string[] = [];
    const r = await bandejaCommand(
      `releer ${it0.id}`,
      deps(async (u) => {
        pedidas.push(u);
        return EVENTO_HTML;
      }),
    );
    expect(pedidas).toEqual(['https://junta.example/2026']);
    expect(r.text).toContain('🔄 Releída: 📅 es un evento: «Junta General de Accionistas 2026»');
    expect(r.text).toContain('📅 miércoles 2 dic, 12:00 · Madrid');
    expect(r.buttons?.some((b) => b.label === '📅 Al calendario')).toBe(true);
    const fresh = store.get(it0.id);
    expect(fresh?.score).toBe(6);
    expect(fresh?.verdict).toBe('ideas');
    expect(fresh?.ideas).toEqual(['dividendo']);
    expect(fresh?.extra.tags).toEqual(['bolsa']);
    expect(fresh?.extra.evento?.inicio).toBe('2026-12-02T12:00:00+01:00');
    // Y «/bandeja calendario N» ya enseña qué apunta.
    const cal = await bandejaCommand(`calendario ${it0.id}`, deps());
    expect(cal.text).toContain('¿Lo apunto en tu Google Calendar?');
  });

  it('una receta vieja gana «🛒 A la compra»', async () => {
    const it0 = vieja('https://recetas.example/tortilla');
    const r = await bandejaCommand(
      `releer ${it0.id}`,
      deps(async () => RECETA_HTML),
    );
    expect(r.text).toContain('🛒 es una receta (3 ingredientes)');
    expect(r.buttons?.some((b) => b.label === '🛒 A la compra')).toBe(true);
  });

  it('«/bandeja calendario N» sin evento ofrece «🔄 Releer la página» como botón', async () => {
    const it0 = vieja();
    const r = await bandejaCommand(`calendario ${it0.id}`, deps());
    expect(r.text).toContain('no trae la fecha de un evento');
    const b = r.buttons?.[0];
    expect(b?.label).toBe('🔄 Releer la página');
    expect(commandFromCallback(b?.action ?? '')).toBe(`/bandeja releer ${it0.id}`);
  });

  it('si la página no abre, no cambia nada; sin enlace, lo dice; va aparte (lento)', async () => {
    const it0 = vieja();
    const r = await bandejaCommand(
      `releer ${it0.id}`,
      deps(async () => {
        throw new Error('ETIMEDOUT');
      }),
    );
    expect(r.text).toContain('No pude abrir la página');
    expect(store.get(it0.id)?.extra).toEqual(it0.extra);
    const nota = store.add(CHAT, { kind: 'texto', title: 'idea suelta' }, NOV11, '2026-11-01');
    const r2 = await bandejaCommand(
      `releer ${nota.item.id}`,
      deps(async () => EVENTO_HTML),
    );
    expect(r2.text).toContain('no tiene una página que releer');
    expect(bandejaSlowSub(`releer ${it0.id}`)).toBe(true);
    expect((await bandejaCommand(`releer ${it0.id}`, deps())).text).toContain('no está disponible');
  });

  it('otra cosa del mismo número de otro chat no se relee', async () => {
    const it0 = vieja();
    const r = await bandejaCommand(`releer ${it0.id}`, {
      ...deps(async () => EVENTO_HTML),
      chatId: '999',
    });
    expect(r.text).toContain('No tengo la');
  });
});
