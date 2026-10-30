import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// La sonda de extremo a extremo se guardó una vez como UTF-8 leído en Windows-1252: imprimía
// «PASA  … â€” detalle» y «el panel no apareciÃ³». Es lo que lee Nico en el informe y lo
// que parsea measure.ts.
const MOJIBAKE = /â€|Ã[\u0080-\u00bf]|Â[\u00a0-\u00bf]/;

describe('evolve/: textos sin mojibake', () => {
  it('ningún fichero de evolve/ tiene UTF-8 mal decodificado', () => {
    const dir = join(import.meta.dirname, '..', 'evolve');
    const bad = readdirSync(dir)
      .filter((f) => /\.(ts|mjs|json)$/.test(f))
      .flatMap((f) =>
        readFileSync(join(dir, f), 'utf8')
          .split('\n')
          .flatMap((l, i) => (MOJIBAKE.test(l) ? [`${f}:${i + 1}`] : [])),
      );
    expect(bad).toEqual([]);
  });
});
