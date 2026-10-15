// Item 9c (timeline de memoria): tests escritos ANTES de la implementacion.
// Capa historia del patron indice -> timeline -> detalle: TODAS las entradas
// agrupadas por dia (reciente primero), superadas INCLUIDAS pero marcadas y
// enlazadas (nunca como vigentes), rango from/to inclusivo, cap que descarta
// los dias mas antiguos primero. Detalle: memory action=get con el [id].
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que paths.ts lo capture
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderTimeline, TIMELINE_CAP } from '../src/memory/timeline.js';
import type { MemoryEntry } from '../src/memory.js';
import { MemoryStore } from '../src/memory.js';

function entry(
  id: string,
  date: string,
  text: string,
  supersededBy: string | null = null,
): MemoryEntry {
  return { id, date, text, tags: ['gym'], supersedes: [], supersededBy };
}

const ENTRIES: MemoryEntry[] = [
  entry('a1', '2026-10-01', 'semana 1: press banca 50 kg'),
  entry('a2', '2026-10-01', 'semana 1: sentadilla 60 kg'),
  entry('a3', '2026-10-08', 'semana 2: press banca 51 kg'),
  entry('a4', '2026-10-08', 'semana 2: peso muerto 80 kg'),
  entry('a5', '2026-10-13', 'semana 3: press banca 52 kg', 'a6'),
  entry('a6', '2026-10-14', 'semana 3 corregida: press banca 53 kg'),
];

describe('9c: renderTimeline (capa historia)', () => {
  it('agrupa por dia, dia mas reciente primero, con recuento por dia', () => {
    const r = renderTimeline(ENTRIES);
    expect(r).not.toBeNull();
    const body = r?.body ?? '';
    const i14 = body.indexOf('2026-10-14 (1):');
    const i13 = body.indexOf('2026-10-13 (1):');
    const i08 = body.indexOf('2026-10-08 (2):');
    const i01 = body.indexOf('2026-10-01 (2):');
    for (const i of [i14, i13, i08, i01]) expect(i).toBeGreaterThan(-1);
    expect(i14).toBeLessThan(i13);
    expect(i13).toBeLessThan(i08);
    expect(i08).toBeLessThan(i01);
    expect(r?.days).toBe(4);
    expect(r?.inRange).toBe(6);
  });

  it('las superadas APARECEN pero marcadas y enlazadas (historia, nunca vigente)', () => {
    const r = renderTimeline(ENTRIES);
    const body = r?.body ?? '';
    expect(body).toContain('SUSTITUIDA→[a6]');
    expect(body).toContain('52 kg');
    expect(body).toContain('(1 sustituidas)');
    // La linea de la vigente no lleva marca.
    const vigente = body.split('\n').find((l) => l.includes('[a6]') && !l.includes('SUSTITUIDA→'));
    expect(vigente).toBeDefined();
  });

  it('rango from/to inclusivo y declarado en cabecera', () => {
    const r = renderTimeline(ENTRIES, { from: '2026-10-08', to: '2026-10-13' });
    const body = r?.body ?? '';
    expect(r?.inRange).toBe(3);
    expect(body).toContain('rango 2026-10-08→2026-10-13');
    expect(body).toContain('2026-10-08');
    expect(body).toContain('2026-10-13');
    expect(body).not.toContain('2026-10-01');
    expect(body).not.toContain('2026-10-14');
    // Solo from: abierto por arriba.
    const soloFrom = renderTimeline(ENTRIES, { from: '2026-10-13' });
    expect(soloFrom?.inRange).toBe(2);
    expect(soloFrom?.body).toContain('rango 2026-10-13→…');
  });

  it('rango sin entradas: null (la tool responde "nada esa semana", no bloque vacio)', () => {
    expect(renderTimeline(ENTRIES, { from: '2026-11-01', to: '2026-11-07' })).toBeNull();
    expect(renderTimeline([])).toBeNull();
  });

  it('CAP: descarta los dias mas antiguos primero y la cola declara cuantas', () => {
    const many: MemoryEntry[] = [];
    for (let d = 1; d <= 60; d++) {
      const day = `2026-09-${String(d).padStart(2, '0')}`;
      many.push(entry(`d${d}`, day, `dia ${d}: ${'z'.repeat(200)}`));
    }
    const r = renderTimeline(many);
    expect(r).not.toBeNull();
    expect((r?.body ?? '').length).toBeLessThanOrEqual(TIMELINE_CAP);
    expect(r?.hiddenByCap).toBeGreaterThan(0);
    expect(r?.body).toContain(`${r?.hiddenByCap} entradas más antiguas sin mostrar`);
    expect(r?.body).toContain('from=2026-09-01');
    // El dia mas reciente siempre sobrevive.
    expect(r?.body).toContain('2026-09-60');
    expect(r?.body).not.toContain('2026-09-01 (1):');
  });

  it('snippet de 80 chars con elipsis en cada fila', () => {
    const r = renderTimeline([entry('x1', '2026-10-14', `largo ${'y'.repeat(200)}`)]);
    const row = (r?.body ?? '').split('\n').find((l) => l.includes('[x1]'));
    expect(row).toMatch(/^- \[x1\] #gym largo y+…$/);
    expect(row?.length).toBeLessThanOrEqual(110);
  });

  it('integracion store real: correccion por supersede queda marcada en la historia', () => {
    const store = new MemoryStore(mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'tl-')));
    const vieja = store.remember('tl:test#main', 'levanto 52 kg', { tags: ['gym'] });
    const nueva = store.remember('tl:test#main', 'levanto 53 kg', {
      tags: ['gym'],
      supersedes: [vieja.id],
    });
    const r = renderTimeline(store.all('tl:test#main'));
    expect(r?.body).toContain(`SUSTITUIDA→[${nueva.id}]`);
    expect(r?.body).toContain('53 kg');
    expect(r?.body).toContain('(1 sustituidas)');
  });
});
