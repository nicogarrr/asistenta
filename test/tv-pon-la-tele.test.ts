import { describe, expect, it } from 'vitest';
import type { TvToolDeps } from '../src/tools/tv.js';
import { createTvTool } from '../src/tools/tv.js';
import { TvUnreachableError } from '../src/tv/lgtv.js';
import { parseTvCommand } from '../src/tv/natural.js';
import { isTvAlreadyOnError, tvPower } from '../src/tv/power.js';

// Decisión de Nico (30-oct-2026): «pon la tele» es encenderla.
describe('«pon la tele» enciende la tele', () => {
  it.each([
    'pon la tele',
    'pon la tv',
    'Pon la tele, por favor',
    'oye, pon la tele',
    'ponme la tele',
    'pon la televisión',
    'pon la tele ya',
    'enciende la tele',
    'enciéndeme la tele',
    'enciéndeme la tv',
  ])('«%s» -> encender', (t) => {
    expect(parseTvCommand(t)).toEqual({ action: 'power', on: true });
  });

  it.each([
    ['pon la tele más baja', { action: 'volumeStep', steps: -3 }],
    ['pon la tele más alta', { action: 'volumeStep', steps: 3 }],
    ['pon la tele en la 5', { action: 'channel', channel: '5' }],
    ['pon la tele a 20', { action: 'volume', level: 20 }],
  ])('«%s» con destino sigue con su regla', (t, want) => {
    expect(parseTvCommand(t)).toMatchObject(want);
  });

  it.each([
    'pon la tele en netflix',
    '¿pones la tele?',
    '¿por qué no se pone la tele?',
    'pon la tele que empieza el partido',
    'pon la tele de la cocina',
    'pon la tele del salón',
    'pon la pantalla',
    'pon la tele y sube el volumen',
    'pon la tele en 10 minutos',
  ])('«%s» va al modelo', (t) => {
    expect(parseTvCommand(t)).toBeNull();
  });
});

describe('encender con la tele ya encendida', () => {
  const yaEncendida = new Error(
    'La TV rechazo ssap://com.webos.service.tvpower/power/turnOnScreen: The current state is Active',
  );

  it('reconoce la respuesta de LG y nada más', () => {
    expect(isTvAlreadyOnError(yaEncendida)).toBe(true);
    expect(
      isTvAlreadyOnError(new Error('La TV rechazo ssap://x/turnOnScreen: already screen on')),
    ).toBe(true);
    expect(
      isTvAlreadyOnError(new Error('La TV rechazo ssap://x/turnOnScreen: not permitted')),
    ).toBe(false);
    expect(isTvAlreadyOnError(new Error('La TV rechazo ssap://system/turnOff: already'))).toBe(
      false,
    );
    expect(isTvAlreadyOnError(new TvUnreachableError('no conecta'))).toBe(false);
  });

  it('tvPower no falla ni manda Wake-on-LAN', async () => {
    let woke = 0;
    const out = await tvPower(true, {
      ssap: async () => {
        throw yaEncendida;
      },
      wake: async () => {
        woke += 1;
      },
    });
    expect(out).toEqual({ via: 'ssap', verified: true, alreadyOn: true });
    expect(woke).toBe(0);
  });

  it('otro rechazo de la tele sigue siendo un error', async () => {
    await expect(
      tvPower(true, {
        ssap: async () => {
          throw new Error('La TV rechazo ssap://x/turnOnScreen: not permitted');
        },
      }),
    ).rejects.toThrow(/not permitted/);
  });

  function deps(power: TvToolDeps['power']): TvToolDeps {
    return {
      shot: async () => ({ image: Buffer.alloc(1), mimeType: 'image/jpeg' }),
      foreground: async () => ({ appId: 'x', category: [] }),
      apps: async () => [],
      launch: async () => {},
      key: async () => {},
      toast: async () => {},
      power,
      saveFrame: () => '',
      getState: () => null,
      setState: () => {},
    };
  }

  it('«pon la tele» con la tele ya encendida contesta claro', async () => {
    const calls: boolean[] = [];
    const res = await createTvTool(
      deps(async (on) => {
        calls.push(on);
        return { via: 'ssap', verified: true, alreadyOn: true };
      }),
    ).execute('id', { action: 'command', text: 'pon la tele' } as never);
    expect(calls).toEqual([true]);
    const text = res.content.map((c) => ('text' in c ? c.text : '')).join('\n');
    expect(text).toContain('La tele ya estaba encendida.');
    expect(text).not.toMatch(/No confirma|apagada del todo/);
  });
});
