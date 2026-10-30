import { describe, expect, it } from 'vitest';
import { type SceneDef, TV_SCENES } from '../src/tv/scenes.js';

function scene(key: string): SceneDef {
  const def = TV_SCENES[key];
  if (!def) throw new Error(`sin rutina ${key}`);
  return def;
}

// Decisión de Nico (30-oct-2026, «elige las opciones con más lógica»): las
// rutinas no añaden extras de Glasshouse persistentes ni arriesgados.
const ALLOWED = new Set(['power', 'mute', 'volume', 'launch', 'toast']);

describe('rutinas de la tele: extras de Glasshouse decididos', () => {
  it('«apagar todo» = aviso + apagar, sin cerrar la app antes', () => {
    expect(scene('apagar-todo').build({})).toEqual([
      { action: 'toast', message: 'Apagando. Buenas noches.' },
      { action: 'power', on: false },
    ]);
  });

  it('«modo noche» solo baja el volumen: no enciende ni toca imagen o temporizador', () => {
    const steps = scene('noche').build({});
    expect(steps.map((s) => s.action)).toEqual(['volume', 'toast']);
    expect(steps.some((s) => s.action === 'power')).toBe(false);
  });

  it.each(Object.keys(TV_SCENES))('«%s» solo usa pasos conocidos', (key) => {
    for (const opts of [{}, { appId: 'netflix', level: 30 }]) {
      for (const step of scene(key).build(opts)) {
        expect(ALLOWED.has(step.action)).toBe(true);
      }
    }
  });
});
