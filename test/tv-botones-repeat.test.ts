/**
 * Mando /tv: la MISMA pulsación (mismo chat, mismo botón) en menos de 1 s se
 * ignora, salvo Vol ± (subir dos de golpe es a propósito). Tele de mentira.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createTvPressGuard,
  TV_REPEAT_IGNORED,
  TV_REPEAT_WINDOW_MS,
  tvButtonCommand,
} from '../src/tv/tv-chat-command.js';

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('createTvPressGuard', () => {
  it('marca como repetida la misma clave dentro de la ventana, no fuera', () => {
    const c = clock();
    const g = createTvPressGuard(1000, c.now);
    expect(g.isRepeat('1:mute')).toBe(false);
    c.advance(999);
    expect(g.isRepeat('1:mute')).toBe(true);
    c.advance(1);
    expect(g.isRepeat('1:mute')).toBe(false);
  });

  it('una repetición ignorada no alarga la ventana', () => {
    const c = clock();
    const g = createTvPressGuard(1000, c.now);
    g.isRepeat('k');
    c.advance(600);
    expect(g.isRepeat('k')).toBe(true);
    c.advance(400);
    expect(g.isRepeat('k')).toBe(false);
  });

  it('claves distintas no se pisan', () => {
    const c = clock();
    const g = createTvPressGuard(1000, c.now);
    expect(g.isRepeat('1:mute')).toBe(false);
    expect(g.isRepeat('1:off')).toBe(false);
    expect(g.isRepeat('2:mute')).toBe(false);
  });

  it('la ventana por defecto es 1 s', () => {
    expect(TV_REPEAT_WINDOW_MS).toBe(1000);
  });
});

describe('tvButtonCommand con filtro de doble pulsación', () => {
  function setup() {
    const c = clock();
    const guard = createTvPressGuard(TV_REPEAT_WINDOW_MS, c.now);
    const run = vi.fn(async (text: string) => `ok ${text}`);
    return { c, guard, run };
  }

  it('doble toque en «Silencio» manda la orden una sola vez', async () => {
    const { guard, run } = setup();
    const deps = { isOwner: true, run, guard, chatId: '42' };
    expect(await tvButtonCommand('tv:mute', deps)).toBe('ok silencio');
    expect(await tvButtonCommand('tv:mute', deps)).toBe(TV_REPEAT_IGNORED);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('pasado 1 s la misma pulsación vuelve a contar', async () => {
    const { c, guard, run } = setup();
    const deps = { isOwner: true, run, guard, chatId: '42' };
    await tvButtonCommand('tv:off', deps);
    c.advance(1000);
    await tvButtonCommand('tv:off', deps);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('Vol + y Vol − no se filtran (dos toques = dos pasos)', async () => {
    const { guard, run } = setup();
    const deps = { isOwner: true, run, guard, chatId: '42' };
    await tvButtonCommand('tv:vup', deps);
    await tvButtonCommand('tv:vup', deps);
    await tvButtonCommand('tv:vdown', deps);
    await tvButtonCommand('tv:vdown', deps);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('botones distintos seguidos sí se mandan', async () => {
    const { guard, run } = setup();
    const deps = { isOwner: true, run, guard, chatId: '42' };
    await tvButtonCommand('tv:on', deps);
    await tvButtonCommand('tv:netflix', deps);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('una pulsación ajena (no dueño) no gasta la ventana del dueño', async () => {
    const { guard, run } = setup();
    const out = await tvButtonCommand('tv:mute', { isOwner: false, run, guard, chatId: '42' });
    expect(out).toMatch(/Solo el dueño/);
    expect(await tvButtonCommand('tv:mute', { isOwner: true, run, guard, chatId: '42' })).toBe(
      'ok silencio',
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('sin filtro (como antes) cada pulsación cuenta', async () => {
    const run = vi.fn(async () => 'ok');
    await tvButtonCommand('tv:mute', { isOwner: true, run });
    await tvButtonCommand('tv:mute', { isOwner: true, run });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
