import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeQuery } from '../src/books/protocol.js';
import { resumenSesion } from '../src/webui/client-format.js';

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('cortes sin medio emoji, cuarta ola (bugs14)', () => {
  it('sanitizeQuery: la búsqueda de libros no manda medio emoji', () => {
    const out = sanitizeQuery(`${'a'.repeat(119)}🎉${'b'.repeat(50)}`);
    expect(loneSurrogate.test(out)).toBe(false);
  });

  it('resumenSesion: el extracto del panel no enseña medio emoji', () => {
    const out = resumenSesion({ snippet: `${'a'.repeat(216)}🎉${'b'.repeat(50)}` }, 0, Date.now());
    expect(loneSurrogate.test(out.extracto)).toBe(false);
    expect(out.extracto.endsWith('…')).toBe(true);
  });

  it('cli.ts no corta textos a ciegas (guard estático)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf8');
    const offenders = src
      .split('\n')
      .filter((l) => /\.slice\(0, (80|120|160|180|200|400|3500|4000)\)/.test(l))
      .filter((l) => !l.includes('sliceSafe'))
      // Solo log interno (no lo ve el usuario ni el modelo).
      .filter((l) => !l.includes('ocr command failed'));
    expect(offenders).toEqual([]);
  });

  it('textos cortados en grill, backends, briefing y kindle usan sliceSafe (guard estático)', () => {
    for (const [file, max] of [
      ['src/skills/grill.ts', '(200|220|240)'],
      ['src/skills/autocreate.ts', '300'],
      ['src/web/backends.ts', 'maxChars'],
      ['src/briefing.ts', 'room'],
      ['src/books/kindle.ts', '120'],
      ['src/research/deep-research.ts', '277'],
      ['src/project-context.ts', '80'],
      ['src/funciones.ts', '40'],
    ] as const) {
      const src = readFileSync(join(__dirname, '..', file), 'utf8');
      const offenders = src
        .split('\n')
        .filter((l) => new RegExp(`\\.slice\\(0, ${max}\\)`).test(l))
        .filter((l) => !l.includes('sliceSafe'));
      expect(offenders, file).toEqual([]);
    }
  });
});
