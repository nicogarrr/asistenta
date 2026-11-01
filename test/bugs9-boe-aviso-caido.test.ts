import { describe, expect, it } from 'vitest';
import { caidoEnRutina, createBoeTool } from '../src/tools/boe.js';

// asis-bugs-9: con el BOE caído, la rutina del aviso escribía «No pude consultar el BOE ahora
// mismo. Prueba otra vez en un rato.», como si el dueño hubiera preguntado. Ahora dice qué pasa
// y que sigue mirando; siempre la misma frase, así «solo si cambia» la manda una vez por caída.
const VIERNES = () => new Date('2026-10-30T09:00:00Z');
const SABADO = () => new Date('2026-10-31T09:00:00Z');
const off = (async () => {
  throw new TypeError('fetch failed');
}) as unknown as typeof fetch;
const textOf = (r: { content: { type: string; text?: string }[] }): string =>
  r.content.map((c) => c.text ?? '').join('');

describe('boe: aviso con el BOE caído', () => {
  it('la rutina no dice «prueba otra vez»: dice que no pudo mirar y que sigue', async () => {
    const out = textOf(
      await createBoeTool({ fetchFn: off, now: VIERNES }).execute('t', {
        buscar: 'ayudas vivienda',
        rutina: true,
      }),
    );
    expect(out).not.toContain('Prueba otra vez');
    expect(out).toBe(caidoEnRutina('ayudas vivienda'));
    expect(out).toContain('no he podido mirar el BOE por «ayudas vivienda»');
    // Otro día de caída: la misma frase (una sola vez por caída con «solo si cambia»).
    const sab = textOf(
      await createBoeTool({ fetchFn: off, now: SABADO }).execute('t', {
        buscar: 'ayudas vivienda',
        rutina: true,
      }),
    );
    expect(sab).toBe(out);
  });

  it('preguntando a mano sigue igual', async () => {
    const out = textOf(
      await createBoeTool({ fetchFn: off, now: VIERNES }).execute('t', { buscar: 'vivienda' }),
    );
    expect(out).toBe('No pude consultar el BOE ahora mismo. Prueba otra vez en un rato.');
  });
});
