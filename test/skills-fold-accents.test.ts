import { describe, expect, it } from 'vitest';
import { fuzzyNameMatch } from '../src/skills/autocreate.js';
import { slugify } from '../src/skills/store.js';

/**
 * Caracterización antes de pasar sus pliegues de acentos a src/text.ts (foldAccents):
 * el resultado tiene que ser idéntico, incluidas mayúsculas acentuadas, ñ, letras
 * con marcas combinantes sueltas y símbolos fuera del latín.
 */
const NAMES = [
  'Ñandú Café',
  'RESERVAR MESA EN EL BARRIO',
  'Pedir cita médica — Ñ',
  'a\u0301rbol y Árbol',
  'İstanbul Ǆemal',
  'ﬁcha técnica ½',
  'Ölçü über straße',
  '   ',
  'çÇ ãõ ÿ',
];

describe('pliegue de acentos en skills (caracterización)', () => {
  it('slugify da el mismo id que antes', () => {
    expect(NAMES.map((n) => slugify(n))).toMatchInlineSnapshot(`
      [
        "nandu-cafe",
        "reservar-mesa-en-el-barrio",
        "pedir-cita-medica-n",
        "arbol-y-arbol",
        "istanbul-emal",
        "cha-tecnica",
        "olcu-uber-stra-e",
        "skill",
        "cc-ao-y",
      ]
    `);
  });
  it('fuzzyNameMatch empareja igual que antes', () => {
    const pairs: Array<[string, string]> = [
      ['Reservar mesa', 'reservar MESA'],
      ['Cita médica', 'cita medica'],
      ['Ñandú', 'nandu'],
      ['İstanbul', 'istanbul'],
      ['Árbol', 'a\u0301rbol'],
      ['straße', 'strasse'],
      ['café', 'te'],
    ];
    expect(pairs.map(([a, b]) => fuzzyNameMatch(a, b))).toMatchInlineSnapshot(`
      [
        true,
        true,
        true,
        true,
        true,
        false,
        false,
      ]
    `);
  });
});
