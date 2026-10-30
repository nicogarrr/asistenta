/**
 * Rutinas «modo noche» y «apagar todo»: pasos, omisiones segun el estado en
 * vivo y ordenes naturales. El modo cine sigue igual.
 */

import { describe, expect, it } from 'vitest';
import { describeTvIntent, parseTvCommand } from '../src/tv/natural.js';
import {
  NOCHE_DEFAULT_LEVEL,
  resolveScene,
  runScene,
  type SceneStep,
  summarizeScene,
  TV_SCENES,
} from '../src/tv/scenes.js';

function runner(isOn?: () => Promise<boolean>, hasGlasshouse = true) {
  const done: SceneStep[] = [];
  return {
    done,
    deps: {
      hasGlasshouse,
      isOn,
      exec: async (s: SceneStep) => {
        done.push(s);
        return 'ok';
      },
    },
  };
}

describe('modo noche', () => {
  it('baja el volumen (8 por defecto) y avisa, sin encender', () => {
    const steps = TV_SCENES.noche?.build({}) ?? [];
    expect(steps).toEqual([
      { action: 'volume', level: NOCHE_DEFAULT_LEVEL },
      { action: 'picture', mode: 'eco' },
      { action: 'toast', message: 'Modo noche: volumen bajo e imagen oscura.' },
    ]);
    expect(NOCHE_DEFAULT_LEVEL).toBe(8);
    expect(steps.some((s) => s.action === 'power')).toBe(false);
    expect(TV_SCENES.noche?.build({ level: 3 })[0]).toEqual({ action: 'volume', level: 3 });
  });

  it('con la tele apagada no manda nada', async () => {
    const r = runner(async () => false);
    const res = await runScene(TV_SCENES.noche?.build({}) ?? [], r.deps);
    expect(r.done).toEqual([]);
    expect(res.map((x) => x.status)).toEqual(['omitido', 'omitido', 'omitido']);
    expect(res[0]?.text).toBe('la tele esta apagada');
  });

  it('con la tele encendida ejecuta los pasos', async () => {
    const r = runner(async () => true);
    await runScene(TV_SCENES.noche?.build({}) ?? [], r.deps);
    expect(r.done.map((s) => s.action)).toEqual(['volume', 'picture', 'toast']);
  });

  it('si el estado falla, actua (como antes)', async () => {
    const r = runner(async () => {
      throw new Error('sin respuesta');
    });
    await runScene(TV_SCENES.noche?.build({}) ?? [], r.deps);
    expect(r.done.map((s) => s.action)).toEqual(['volume', 'picture', 'toast']);
  });
});

describe('apagar todo', () => {
  it('avisa y apaga la tele encendida', async () => {
    const r = runner(async () => true);
    const steps = TV_SCENES['apagar-todo']?.build({}) ?? [];
    const res = await runScene(steps, r.deps);
    expect(r.done).toEqual([
      { action: 'toast', message: 'Apagando. Buenas noches.' },
      { action: 'closeForeground' },
      { action: 'power', on: false },
    ]);
    expect(summarizeScene('apagado', res, steps.length)).toContain('apagar la tele: hecho');
  });

  it('una tele ya apagada no se toca', async () => {
    const r = runner(async () => false);
    const res = await runScene(TV_SCENES['apagar-todo']?.build({}) ?? [], r.deps);
    expect(r.done).toEqual([]);
    expect(res[2]?.text).toBe('ya estaba apagada');
  });

  it('sin status se apaga igualmente', async () => {
    const r = runner(undefined);
    await runScene(TV_SCENES['apagar-todo']?.build({}) ?? [], r.deps);
    expect(r.done.map((s) => s.action)).toEqual(['toast', 'closeForeground', 'power']);
  });
});

describe('modo cine no cambia', () => {
  it('tele apagada: enciende y sigue', async () => {
    const r = runner(async () => false);
    await runScene(TV_SCENES.cine?.build({}) ?? [], r.deps);
    expect(r.done.map((s) => s.action)).toEqual(['power', 'mute', 'volume', 'toast']);
  });

  it('si encender falla, para', async () => {
    const done: string[] = [];
    const res = await runScene(TV_SCENES.cine?.build({}) ?? [], {
      hasGlasshouse: true,
      isOn: async () => false,
      exec: async (s) => {
        done.push(s.action);
        if (s.action === 'power') throw new Error('no llego');
        return 'ok';
      },
    });
    expect(done).toEqual(['power']);
    expect(res).toHaveLength(1);
  });
});

describe('nombres y ordenes naturales', () => {
  it('alias de las rutinas', () => {
    expect(resolveScene('Modo Noche')).toBe('noche');
    expect(resolveScene('nocturno')).toBe('noche');
    expect(resolveScene('apagar todo')).toBe('apagar-todo');
    expect(resolveScene('apagar-todo')).toBe('apagar-todo');
  });

  it('parseTvCommand', () => {
    expect(parseTvCommand('pon el modo noche')).toEqual({ action: 'scene', scene: 'noche' });
    expect(parseTvCommand('modo nocturno con YouTube')).toEqual({
      action: 'scene',
      scene: 'noche',
      appId: 'youtube',
    });
    expect(parseTvCommand('Apaga todo')).toEqual({ action: 'scene', scene: 'apagar-todo' });
    expect(parseTvCommand('apágalo todo, por favor')).toEqual({
      action: 'scene',
      scene: 'apagar-todo',
    });
    // Lo de antes sigue igual.
    expect(parseTvCommand('apaga la tele')).toEqual({ action: 'power', on: false });
    expect(parseTvCommand('apaga el sonido')?.action).toBe('mute');
  });

  it('descripcion', () => {
    expect(describeTvIntent({ action: 'scene', scene: 'apagar-todo' })).toBe('apagarlo todo');
    expect(describeTvIntent({ action: 'scene', scene: 'noche' })).toBe('activar el modo noche');
  });
});
