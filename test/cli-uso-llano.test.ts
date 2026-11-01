import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as uso from '../src/cli-uso.js';

describe('órdenes de pa mal escritas: castellano llano', () => {
  const textos = Object.entries(uso);

  it('hay un texto por cada orden', () => {
    expect(textos.map(([k]) => k).sort()).toEqual([
      'BOOKS_USAGE',
      'OPENGYM_PAIR_USAGE',
      'OPENGYM_USAGE',
      'STOP_USAGE',
      'WATCHDOG_USAGE',
    ]);
  });

  it.each(textos)('%s dice qué hacer sin notación técnica', (_k, texto) => {
    expect(texto).toMatch(/^(No conozco esa orden|Falta el código)\. Usa/);
    expect(texto).not.toMatch(/uso:|\||\[url\]|\[--|<[a-zá-ú ]+>/i);
    expect(texto.split('\n')).toHaveLength(1);
  });

  it('cli.ts ya no escribe líneas «uso: pa …»', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).not.toMatch(/['`"]uso: pa /);
  });
});
