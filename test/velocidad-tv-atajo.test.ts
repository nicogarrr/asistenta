// Atajo sin modelo para órdenes de tele claras en mensajes normales (asis-velocidad-1).
import { describe, expect, it } from 'vitest';
import { TV_CONTEXT_MS, tvFastPathIntent } from '../src/tv/fast-path.js';

const NOW = 1_000_000_000;
const cold = (text: string, tvNames: string[] = []) =>
  tvFastPathIntent({ text, now: NOW, lastTvOrderAt: null, tvNames });
const warm = (text: string) => tvFastPathIntent({ text, now: NOW, lastTvOrderAt: NOW - 20_000 });

describe('atajo de tele sin modelo', () => {
  it('nombra la tele: va al momento', () => {
    expect(cold('baja el volumen de la tele')).toMatchObject({ action: 'volumeStep' });
    expect(cold('apaga la tele')).toEqual({ action: 'power', on: false });
    expect(cold('pon netflix en la tele')).toMatchObject({ action: 'launch' });
    expect(cold('Baja el volumen de la tele.')).toMatchObject({ action: 'volumeStep' });
  });

  it('nombra una tele conocida por su nombre', () => {
    expect(cold('pon netflix en el salón', ['salón'])).toMatchObject({ action: 'launch' });
    expect(cold('pon netflix en el salón')).toBeNull();
  });

  it('sin «tele» y sin orden reciente: al modelo como siempre', () => {
    for (const t of ['abre netflix', 'baja el volumen', 'apaga', 'abajo', 'ok', 'silencio']) {
      expect(cold(t), t).toBeNull();
    }
  });

  it('navegando (orden de tele hace poco): flechas, atrás, volumen, apps de tele', () => {
    expect(warm('abajo')).toEqual({ action: 'key', name: 'DOWN' });
    expect(warm('vuelve atrás')).toEqual({ action: 'key', name: 'BACK' });
    expect(warm('dale a ok')).toEqual({ action: 'key', name: 'ENTER' });
    expect(warm('baja el volumen')).toMatchObject({ action: 'volumeStep' });
    expect(warm('abre netflix')).toMatchObject({ action: 'launch', appId: 'netflix' });
  });

  it('navegando: un «ok/vale/sí» suelto o «para» no se ataja (puede ser otra respuesta)', () => {
    for (const t of ['ok', 'vale', 'sí', 'Ok.', 'para']) expect(warm(t), t).toBeNull();
  });

  it('navegando: abrir algo que no es app de tele sigue al modelo', () => {
    expect(warm('abre el correo')).toBeNull();
    expect(warm('abre chrome')).toBeNull();
  });

  it('nunca si nombra el PC o lleva hora/condición', () => {
    expect(cold('apaga la tele y el ordenador')).toBeNull();
    expect(warm('sube el volumen del ordenador')).toBeNull();
    expect(cold('apaga la tele a las 12')).toBeNull();
  });

  it('la ventana de navegación caduca a los 3 min', () => {
    expect(
      tvFastPathIntent({ text: 'abajo', now: NOW, lastTvOrderAt: NOW - TV_CONTEXT_MS - 1 }),
    ).toBeNull();
    expect(
      tvFastPathIntent({ text: 'abajo', now: NOW, lastTvOrderAt: NOW - TV_CONTEXT_MS + 1000 }),
    ).not.toBeNull();
  });

  it('mensajes largos o de varias líneas: al modelo', () => {
    expect(cold(`apaga la tele ${'y '.repeat(50)}`)).toBeNull();
    expect(cold('apaga la tele\ny luego recuérdame algo')).toBeNull();
  });
});

describe('hora de la última orden de tele', () => {
  it('se apunta al terminar bien una orden (cualquier vía) y no si falla', async () => {
    const { createTvTool, tvLastOrderAt } = await import('../src/tools/tv.js');
    let fail = false;
    const deps = {
      key: async () => {
        if (fail) throw new Error('tele apagada');
      },
      keys: async () => {},
    } as never;
    const tool = createTvTool(deps);
    const before = Date.now();
    await tool.execute('t', { action: 'key', names: ['DOWN', 'DOWN'] } as never);
    const at = tvLastOrderAt();
    expect(at).not.toBeNull();
    expect(at as number).toBeGreaterThanOrEqual(before);
    fail = true;
    await new Promise((r) => setTimeout(r, 5));
    await tool.execute('t', { action: 'command', text: 'abajo' } as never).catch(() => null);
    expect(tvLastOrderAt()).toBe(at);
  });
});
