import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commandFromCallback } from '../src/channels/telegram.js';
import { compareWatchButtons } from '../src/cli.js';
import { COMPARE_WATCH_MS, COMPARE_WATCH_STALE, CompareWatchLinks } from '../src/watch/compare.js';

/**
 * /compara: botón «👀 Vigilar» que equivale a /vigila <ese enlace>. El enlace NUNCA va
 * en el callback_data: el botón lleva un id corto que apunta a una lista en memoria
 * (vale una vez, 24 h y solo desde el mismo chat).
 */
const LINK = 'https://tienda.example/p/zapatillas-x?ref=abc&color=rojo';

describe('«👀 Vigilar» en /compara', () => {
  it('el botón se lee como /vigila enlace <id> y no lleva el enlace', () => {
    const b = compareWatchButtons('a1b2c3d4');
    expect(b?.map((x) => x.label)).toEqual(['👀 Vigilar']);
    expect(commandFromCallback(b?.[0]?.action ?? '')).toBe('/vigila enlace a1b2c3d4');
    expect(b?.[0]?.action).not.toContain('tienda.example');
    expect(commandFromCallback('cmd:vigila a1b2c3d4')).toBeUndefined();
  });

  it('el id vale una vez, solo en su chat', () => {
    const links = new CompareWatchLinks(() => 0);
    const id = links.remember('42', LINK);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(links.take(id, '77')).toBeUndefined();
    expect(links.take(id, '42')).toBe(LINK);
    expect(links.take(id, '42')).toBeUndefined();
  });

  it('caduca a las 24 h y guarda como mucho 200', () => {
    let t = 0;
    const links = new CompareWatchLinks(() => t, 200);
    const old = links.remember('42', LINK);
    t = COMPARE_WATCH_MS + 1;
    expect(links.take(old, '42')).toBeUndefined();
    const ids = Array.from({ length: 205 }, () => links.remember('42', LINK));
    expect(links.take(ids[0] as string, '42')).toBeUndefined();
    expect(links.take(ids[204] as string, '42')).toBe(LINK);
    expect(COMPARE_WATCH_STALE).toContain('/vigila');
  });

  it('el daemon pone el botón tras comparar y /vigila resuelve el id', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const compara = src.slice(src.indexOf('const cmdCompara = async')).slice(0, 1800);
    expect(compara).toContain(
      'buttons: compareWatchButtons(compareWatchLinks.remember(inbound.chatId, url))',
    );
    const vigila = src.slice(src.indexOf('const cmdVigila = async')).slice(0, 600);
    expect(vigila).toContain('compareWatchLinks.take(');
  });
});
