import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configurarAdjuntos, mirarAdjunto } from '../src/mail/adjuntos.js';

// bugs-34: dos «grafica.png» hechas en el mismo segundo se guardan como
// «20261111-120000-grafica.png» y «20261111-120000-2-grafica.png». «Adjunta grafica.png»
// debe mandar la nueva (la -2), pero el orden de texto ponía «-2-» antes y salía la vieja.

afterEach(() => configurarAdjuntos(null));

describe('adjuntos de «creados»: el más nuevo con el mismo nombre', () => {
  it('en el mismo segundo gana el número más alto (-2, -10), no el orden de texto', () => {
    const base = mkdtempSync(join(tmpdir(), 'bugs34-creados-'));
    const creados = join(base, 'creados');
    mkdirSync(creados, { recursive: true });
    for (const id of [
      '20261111-120000-grafica.png',
      '20261111-120000-2-grafica.png',
      '20261111-115959-grafica.png',
    ])
      writeFileSync(join(creados, id), id);
    configurarAdjuntos({ creadosDir: creados, stateDir: base, roots: [] });
    expect(mirarAdjunto('grafica.png')).toMatchObject({
      ok: true,
      path: join(creados, '20261111-120000-2-grafica.png'),
    });
    for (let i = 3; i <= 10; i++)
      writeFileSync(join(creados, `20261111-120000-${i}-grafica.png`), 'x');
    expect(mirarAdjunto('grafica.png')).toMatchObject({
      ok: true,
      path: join(creados, '20261111-120000-10-grafica.png'),
    });
  });
});
