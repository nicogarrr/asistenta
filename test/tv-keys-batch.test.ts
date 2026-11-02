/**
 * tvKeys (ráfaga de teclas por un solo socket) y tvTypeText (escribir en el
 * campo enfocado de la tele), contra la tele falsa. Son los dos atajos que
 * convierten la navegación tecla a tecla y la escritura en buscadores de
 * lentas (un turno por tecla) en una sola acción.
 */
import { describe, expect, it } from 'vitest';
import {
  TV_MAX_KEY_BATCH,
  TV_TYPE_TEXT_MAX,
  tvKey,
  tvKeyGapMs,
  tvKeys,
  tvTypeText,
} from '../src/tv/lgtv.js';
import { FakeWebOsTv } from './helpers/fake-webos-tv.js';

const HOST = '192.168.1.50';
const deps = (tv: FakeWebOsTv, extra: Record<string, unknown> = {}) => ({
  factory: tv.factory,
  inputFactory: tv.inputFactory,
  keyGapMs: 0,
  keyGraceMs: 50,
  ...extra,
});

describe('tvKeys (ráfaga de teclas)', () => {
  it('varias teclas por un solo socket SSAP y un solo socket de input, en orden', async () => {
    const tv = new FakeWebOsTv();
    await tvKeys(HOST, 'KEY123', ['home', 'down', 'down', 'ok'], deps(tv));
    expect(tv.buttons).toEqual(['HOME', 'DOWN', 'DOWN', 'OK']);
    expect(tv.urls).toEqual([`wss://${HOST}:3001`]);
    expect(tv.inputUrls).toEqual([`wss://${HOST}:3001/resources/input`]);
    expect(
      tv.requests.filter((r) => r.uri === 'com.webos.service.networkinput/getPointerInputSocket'),
    ).toHaveLength(1);
    expect(tv.allClosed()).toBe(true);
  });

  it('una sola tecla delega en el camino clásico de tvKey', async () => {
    const tv = new FakeWebOsTv();
    await tvKeys(HOST, 'KEY123', ['back'], deps(tv));
    expect(tv.buttons).toEqual(['BACK']);
    expect(tv.allClosed()).toBe(true);
  });

  it('una tecla ilegal en la ráfaga falla antes de tocar la red', async () => {
    const tv = new FakeWebOsTv();
    await expect(tvKeys(HOST, 'KEY123', ['home', 'hackme'], deps(tv))).rejects.toThrow(
      /Tecla no valida/,
    );
    expect(tv.urls).toEqual([]);
    expect(tv.buttons).toEqual([]);
  });

  it('ráfaga vacía o demasiado larga se rechaza sin abrir nada', async () => {
    const tv = new FakeWebOsTv();
    await expect(tvKeys(HOST, 'KEY123', [], deps(tv))).rejects.toThrow(/vacía/);
    await expect(
      tvKeys(HOST, 'KEY123', Array(TV_MAX_KEY_BATCH + 1).fill('down'), deps(tv)),
    ).rejects.toThrow(new RegExp(`máx ${TV_MAX_KEY_BATCH}`));
    expect(tv.urls).toEqual([]);
  });

  it('acepta mayúsculas y recorta espacios', async () => {
    const tv = new FakeWebOsTv();
    await tvKeys(HOST, 'KEY123', ['  OK ', 'VolumeUp'], deps(tv));
    expect(tv.buttons).toEqual(['OK', 'VOLUMEUP']);
  });
});

describe('tvKeyGapMs', () => {
  it('por defecto 150 ms y acota valores absurdos', () => {
    expect(tvKeyGapMs()).toBe(150);
    expect(tvKeyGapMs({ keyGapMs: 99999 })).toBe(2000);
    expect(tvKeyGapMs({ keyGapMs: -5 })).toBe(0);
    expect(tvKeyGapMs({ keyGapMs: Number.NaN })).toBe(150);
  });
});

describe('tvTypeText', () => {
  it('escribe el texto en el campo enfocado vía insertText', async () => {
    const tv = new FakeWebOsTv();
    await tvTypeText(HOST, 'KEY123', 'el padrino', { factory: tv.factory });
    const req = tv.requests.find((r) => r.uri === 'com.webos.service.ime/insertText');
    expect(req?.payload).toEqual({ text: 'el padrino' });
    expect(tv.allClosed()).toBe(true);
  });

  it('limpia saltos de línea y caracteres de control', async () => {
    const tv = new FakeWebOsTv();
    await tvTypeText(HOST, 'KEY123', 'la casa de\npapel', {
      factory: tv.factory,
    });
    const req = tv.requests.find((r) => r.uri === 'com.webos.service.ime/insertText');
    expect(req?.payload).toEqual({ text: 'la casa depapel' });
  });

  it('rechaza texto vacío o demasiado largo sin tocar la tele', async () => {
    const tv = new FakeWebOsTv();
    await expect(tvTypeText(HOST, 'KEY123', '   \n  ', { factory: tv.factory })).rejects.toThrow(
      /Texto vacío/,
    );
    await expect(
      tvTypeText(HOST, 'KEY123', 'a'.repeat(TV_TYPE_TEXT_MAX + 1), { factory: tv.factory }),
    ).rejects.toThrow(new RegExp(`máx ${TV_TYPE_TEXT_MAX}`));
    expect(tv.requests).toEqual([]);
  });

  it('propaga el error de la tele (insertText rechazado)', async () => {
    const tv = new FakeWebOsTv({
      handlers: {
        'com.webos.service.ime/insertText': () => {
          throw new Error('no focused field');
        },
      },
    });
    await expect(tvTypeText(HOST, 'KEY123', 'hola', { factory: tv.factory })).rejects.toThrow(
      /no focused field/,
    );
  });
});

describe('equivalencia tvKeys(1) vs tvKey', () => {
  it('mismo socket, mismos frames y mismas peticiones', async () => {
    const a = new FakeWebOsTv();
    const b = new FakeWebOsTv();
    await tvKey(HOST, 'KEY123', 'home', deps(a));
    await tvKeys(HOST, 'KEY123', ['home'], deps(b));
    expect(b.urls).toEqual(a.urls);
    expect(b.inputUrls).toEqual(a.inputUrls);
    expect(b.buttons).toEqual(a.buttons);
    expect(b.requests).toEqual(a.requests);
  });
});
