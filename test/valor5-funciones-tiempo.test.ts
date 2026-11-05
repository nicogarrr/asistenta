/**
 * /funciones → «⏰ Agenda»: el texto del tiempo decía «de hoy a 7 días donde vives», pero
 * desde #2041 y #2048 también da el de cualquier ciudad y hora a hora («¿a qué hora para de
 * llover?»). Nico no tenía forma de enterarse de que podía pedirlo.
 */
import { describe, expect, it } from 'vitest';
import { funcionesText } from '../src/funciones.js';

describe('/funciones: el tiempo dice todo lo que sabe hacer', () => {
  it('menciona hora a hora y otras ciudades', () => {
    const text = funcionesText({ owner: true }, 'agenda');
    const line = text.split('\n').find((l) => l.includes('el tiempo')) ?? '';
    expect(line).toContain('hora a hora');
    expect(line).toContain('cualquier ciudad');
    expect(line).toContain('7 días');
    expect(line).not.toContain('donde vives');
  });
});
