import { describe, expect, it } from 'vitest';
import {
  type CompareReport,
  type CompareRow,
  compareVerdict,
  describeCompare,
} from '../src/watch/compare.js';

const SEED = 'https://www.amazon.es/dp/B0ABC12345';

function row(
  store: CompareRow['store'],
  cents: number | null,
  status: CompareRow['status'] = 'ok',
): CompareRow {
  return {
    store,
    status,
    cents,
    inStock: true,
    url: `https://${store}.example/p`,
    match: 'ean',
    note: '',
  };
}

function report(rows: CompareRow[]): CompareReport {
  const ok = rows.filter((r) => r.status === 'ok' && r.cents !== null);
  const best = ok.reduce<CompareRow | null>(
    (a, r) => (a === null || (r.cents ?? 0) < (a.cents ?? 0) ? r : a),
    null,
  );
  return {
    seed: { url: SEED, store: 'amazon', identity: { title: 'Tele 65', ean: null, model: null } },
    rows,
    best,
    at: Date.UTC(2026, 9, 30, 19, 0),
  };
}

describe('/compara dice si tu enlace ya es el mejor precio', () => {
  it('la ficha es la más barata: lo dice y cuánto ahorra frente a la siguiente', () => {
    const r = report([row('amazon', 45999), row('mediamarkt', 49999), row('pccomponentes', 47999)]);
    const v = compareVerdict(r);
    expect(v).toContain('ya es el mejor precio');
    expect(v).toContain('20,00 €');
    expect(v).toContain('PcComponentes');
    expect(describeCompare(r).split('\n').at(-1)).toBe(v);
  });

  it('empate con otra tienda: también es el mejor precio, y lo dice', () => {
    const v = compareVerdict(report([row('mediamarkt', 45999), row('amazon', 45999)]));
    expect(v).toContain('ya es el mejor precio');
    expect(v).toContain('empata con MediaMarkt');
  });

  it('otra tienda es más barata: dice dónde y cuánto, nunca «ya es el mejor»', () => {
    const v = compareVerdict(report([row('amazon', 49999), row('mediamarkt', 45999)]));
    expect(v).not.toContain('ya es el mejor precio');
    expect(v).toContain('MediaMarkt');
    expect(v).toContain('40,00 €');
  });

  it('sin precio en ninguna otra tienda no presume de mejor precio', () => {
    const r = report([
      row('amazon', 49999),
      row('mediamarkt', null, 'no-encontrado'),
      row('fnac', null, 'error'),
    ]);
    expect(compareVerdict(r)).toBeUndefined();
    expect(describeCompare(r)).not.toContain('mejor precio');
  });

  it('sin precio en la propia ficha no hay veredicto', () => {
    expect(
      compareVerdict(report([row('amazon', null, 'no-fiable'), row('mediamarkt', 45999)])),
    ).toBeUndefined();
  });
});
