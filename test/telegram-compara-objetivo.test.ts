import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commandFromCallback } from '../src/channels/telegram.js';
import { compareTargetButton, compareWatchButtons, vigilaArgsFromCompare } from '../src/cli.js';
import {
  type CompareReport,
  type CompareRow,
  CompareWatchLinks,
  suggestedTargetCents,
} from '../src/watch/compare.js';
import { parseVigilaArgs } from '../src/watch/pages.js';

/**
 * /compara: además de «👀 Vigilar», un «🎯 Avisar si baja a X €» que vigila la ficha con
 * objetivo = el mejor precio hallado en otra tienda. Mismo id corto (el enlace nunca va
 * en el botón), una vez, 24 h, mismo chat.
 */
const row = (store: string, cents: number | null, status: CompareRow['status'] = 'ok') =>
  ({
    store,
    status,
    cents,
    inStock: true,
    url: `https://${store}.es/p`,
    match: 'ean',
    note: '',
  }) as CompareRow;
const report = (rows: CompareRow[]): CompareReport => {
  const ok = rows.filter((r) => r.status === 'ok' && r.cents !== null);
  const best = ok.reduce<CompareRow | null>(
    (a, r) => (!a || (r.cents ?? 0) < (a.cents ?? 0) ? r : a),
    null,
  );
  return {
    seed: { url: 'https://amazon.es/p', store: 'amazon', identity: {} },
    rows,
    best,
    at: 0,
  } as unknown as CompareReport;
};

describe('/compara: «🎯 Avisar si baja a …» con el mejor precio', () => {
  it('propone el mejor precio de otra tienda si es más bajo que el de la ficha', () => {
    expect(suggestedTargetCents(report([row('amazon', 50000), row('fnac', 45999)]))).toBe(45999);
  });

  it('sin propuesta si la ficha ya es la más barata o no se sabe su precio', () => {
    expect(
      suggestedTargetCents(report([row('amazon', 40000), row('fnac', 45999)])),
    ).toBeUndefined();
    expect(
      suggestedTargetCents(report([row('amazon', null, 'error'), row('fnac', 45999)])),
    ).toBeUndefined();
    expect(suggestedTargetCents(report([row('amazon', 40000)]))).toBeUndefined();
  });

  it('el botón vigila con objetivo= sin poner el enlace en el botón', () => {
    const links = new CompareWatchLinks(() => 0);
    const r = report([row('amazon', 50000), row('fnac', 45999)]);
    const target = compareTargetButton(r, (t) => links.remember('42', 'https://amazon.es/p', t));
    const b = compareWatchButtons(links.remember('42', 'https://amazon.es/p'), ...target) ?? [];
    expect(b.map((x) => x.label)).toEqual(['👀 Vigilar', '🎯 Avisar si baja a 459,99 €']);
    for (const x of b) expect(x.action).not.toContain('amazon');
    const id =
      /enlace ([0-9a-f]{8})/.exec(commandFromCallback(b[1]?.action ?? '') ?? '')?.[1] ?? '';
    const hit = links.takeEntry(id, '42');
    expect(hit).toEqual({ url: 'https://amazon.es/p', targetCents: 45999 });
    const args = vigilaArgsFromCompare(hit as { url: string; targetCents?: number });
    expect(args).toBe('https://amazon.es/p objetivo=459,99€');
    expect(parseVigilaArgs(args)?.targetCents).toBe(45999);
    expect(links.takeEntry(id, '42')).toBeUndefined();
  });

  it('sin objetivo, solo «👀 Vigilar» y equivale a /vigila <enlace>', () => {
    const links = new CompareWatchLinks(() => 0);
    const r = report([row('amazon', 40000), row('fnac', 45999)]);
    const target = compareTargetButton(r, (t) => links.remember('42', 'u', t));
    expect(target).toEqual([]);
    expect(compareWatchButtons(links.remember('42', 'u'), ...target)?.length).toBe(1);
    expect(vigilaArgsFromCompare({ url: 'https://x.es/p' })).toBe('https://x.es/p');
    expect(vigilaArgsFromCompare({ url: 'u', targetCents: 100005 })).toBe('u objetivo=1000,05€');
  });

  it('/compara añade el botón con objetivo y /vigila lo usa', () => {
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('compareTargetButton(report,');
    expect(cli).toContain('args = vigilaArgsFromCompare(hit);');
  });
});
