import { describe, expect, it } from 'vitest';
import { wideCsvAttachment } from '../src/research/wide-research.js';
import { foldAccents } from '../src/text.js';
import { slugify } from '../src/tools/factory.js';

/**
 * El id de las herramientas de la fábrica y el nombre del CSV de /investiga amplio
 * pasan a usar foldAccents (src/text.ts). Debe ser un cambio sin efecto: se compara
 * con la versión anterior, copiada aquí, en TODOS los puntos de código Unicode y en
 * cadenas mezcladas (incluida la sigma final griega, el único caso en que el orden
 * minúsculas/NFD importa en JavaScript).
 */
const legacyFactory = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'tool';

const legacyCsvSlug = (q: string): string =>
  q
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') || 'tabla';

const csvName = (question: string): string =>
  wideCsvAttachment({ question, rows: [{ item: 'a', cell: 'b' }] } as unknown as Parameters<
    typeof wideCsvAttachment
  >[0])?.filename ?? '';

function* everyCodePoint(): Generator<string> {
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    yield String.fromCodePoint(cp);
  }
}

const MIXED = [
  'Árbol Ñandú',
  'ΣΟΦΟΣ ΚΑΙ ΣΟΦΟΣ',
  'ΑΣ́ ΑΣ̈Β',
  'İstanbul KELVIN K Å',
  'ǅungla ﬁ ß ẞ',
  '  --Precio   del café en Málaga 2026--  ',
  'Herramienta: «Convertir €→$» (versión 2)',
  'a'.repeat(80),
  '',
  '¿¡!?',
];

describe('foldAccents en slugs: sin cambio de comportamiento', () => {
  it('fábrica: igual a la versión anterior en todos los puntos de código', () => {
    const diffs: string[] = [];
    for (const ch of everyCodePoint()) {
      const s = `x${ch}y${ch}`;
      if (slugify(s) !== legacyFactory(s)) diffs.push(ch.codePointAt(0)?.toString(16) ?? '');
    }
    expect(diffs).toEqual([]);
  });

  it('CSV amplio: igual a la versión anterior en todos los puntos de código', () => {
    const diffs: string[] = [];
    for (const ch of everyCodePoint()) {
      const s = `x${ch}y${ch}`;
      if (csvName(s) !== `investigacion-${legacyCsvSlug(s)}.csv`) {
        diffs.push(ch.codePointAt(0)?.toString(16) ?? '');
      }
    }
    expect(diffs).toEqual([]);
  });

  it('cadenas mezcladas (sigma final, ligaduras, longitudes)', () => {
    for (const s of MIXED) {
      expect(slugify(s)).toBe(legacyFactory(s));
      expect(csvName(s)).toBe(`investigacion-${legacyCsvSlug(s)}.csv`);
    }
  });

  it('salidas conocidas', () => {
    expect(slugify('Árbol Ñandú')).toBe('arbol-nandu');
    expect(slugify('¿¡!?')).toBe('tool');
    expect(csvName('Precio del café en Málaga')).toBe(
      'investigacion-precio-del-cafe-en-malaga.csv',
    );
    expect(csvName('')).toBe('investigacion-tabla.csv');
    expect(foldAccents('ΣΟΦΟΣ')).toBe('σοφος');
  });
});
