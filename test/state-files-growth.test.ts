import { describe, expect, it } from 'vitest';
import { STATE_ENTRIES } from '../src/state-files.js';

describe('registro de ficheros de estado: nada crece sin que se sepa', () => {
  it('toda entrada que no se copia y nadie poda dice por qué puede crecer (`growth`)', () => {
    const silent = STATE_ENTRIES.filter(
      (e) => e.backup === false && !e.retention && !e.prune && !e.cap && !e.growth?.trim(),
    ).map((e) => e.name);
    expect(silent).toEqual([]);
  });

  it('`growth` solo aparece donde hace falta (no copiada y sin poda)', () => {
    const extra = STATE_ENTRIES.filter(
      (e) => e.growth && (e.backup !== false || e.retention || e.prune || e.cap),
    ).map((e) => e.name);
    expect(extra).toEqual([]);
  });

  it('las carpetas que crecen a propósito lo dicen explícitamente', () => {
    for (const name of ['browser', 'models', 'memory-consolidation']) {
      const e = STATE_ENTRIES.find((x) => x.name === name);
      expect(e?.growth).toMatch(/crece a propósito/);
    }
  });
});
