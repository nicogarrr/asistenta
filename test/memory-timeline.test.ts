// Item 9c (timeline de memoria): tests escritos ANTES de la implementacion.
// Capa historia del patron indice -> timeline -> detalle: TODAS las entradas
// agrupadas por dia (reciente primero), superadas INCLUIDAS pero marcadas y
// enlazadas (nunca como vigentes), rango from/to inclusivo. Ronda 2 (auditor
// #137): el cap recorta POR FILAS (nunca parte una fila), cuenta las ocultas
// y devuelve un cursor que reanuda dentro del mismo dia; la cabecera usa
// min/max reales (no orden de insercion); las fechas son DE REGISTRO.
// biome-ignore assist/source/organizeImports: orden de carga exigido - fija PA_STATE_DIR antes de que paths.ts lo capture
import { FACTORY_TEST_STATE_DIR } from './factory-test-env.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderTimeline, TIMELINE_CAP } from '../src/memory/timeline.js';
import type { MemoryEntry } from '../src/memory.js';
import { MemoryStore } from '../src/memory.js';
import { createMemoryTool } from '../src/tools/memory.js';

vi.mock('../src/log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  redact: (fields: Record<string, unknown>): Record<string, unknown> => fields,
}));

function entry(
  id: string,
  date: string,
  text: string,
  supersededBy: string | null = null,
): MemoryEntry {
  return { id, date, text, tags: ['gym'], supersedes: [], supersededBy };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const ENTRIES: MemoryEntry[] = [
  entry('a1', '2026-10-01', 'semana 1: press banca 50 kg'),
  entry('a2', '2026-10-01', 'semana 1: sentadilla 60 kg'),
  entry('a3', '2026-10-08', 'semana 2: press banca 51 kg'),
  entry('a4', '2026-10-08', 'semana 2: peso muerto 80 kg'),
  entry('a5', '2026-10-13', 'semana 3: press banca 52 kg', 'a6'),
  entry('a6', '2026-10-14', 'semana 3 corregida: press banca 53 kg'),
];

function textOf(result: { content: Array<{ type: string; text?: string } | unknown> }): string {
  return result.content
    .map((c) => (typeof c === 'object' && c && 'text' in c ? String(c.text) : ''))
    .join('\n');
}

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
    expect(r?.nextCursor).toBeNull();
    // Dentro del dia tambien reciente primero (insercion inversa del store).
    expect(body.indexOf('- [a2]')).toBeLessThan(body.indexOf('- [a1]'));
    expect(body.indexOf('- [a4]')).toBeLessThan(body.indexOf('- [a3]'));
  });

  it('las fechas se titulan como DE REGISTRO, no como cuando ocurrio el hecho', () => {
    const r = renderTimeline(ENTRIES);
    expect(r?.body).toContain('Notas guardadas por día (fecha de registro');
    expect(r?.body).not.toContain('when things happened');
  });

  it('cabecera: min/max reales aunque el orden de insercion sea inverso', () => {
    const r = renderTimeline([
      entry('n1', '2026-10-15', 'primera insertada'),
      entry('n2', '2026-01-01', 'segunda insertada'),
    ]);
    expect(r?.body).toContain('entre 2026-01-01 y 2026-10-15');
    expect(r?.body).not.toContain('entre 2026-10-15 y 2026-01-01');
  });

  it('fechas desconocidas o imposibles: grupo aparte, sin afirmar cuando paso', () => {
    const mezcla = [
      entry('v1', '2026-10-15', 'con fecha valida'),
      entry('u1', '', 'sin fecha'),
      entry('u2', '2026-09-60', 'fecha imposible'),
    ];
    const r = renderTimeline(mezcla);
    expect(r?.body).toContain('entre 2026-10-15 y 2026-10-15');
    expect(r?.body).toContain('2 con fecha desconocida');
    expect(r?.body).toContain('fecha desconocida (2):');
    expect(r?.body).toContain('[u1]');
    expect(r?.body).toContain('[u2]');
    // El grupo desconocido va despues de los dias validos.
    const posDia = r?.body.indexOf('2026-10-15 (1):') ?? -1;
    const posGrupo = r?.body.indexOf('fecha desconocida (2):') ?? -1;
    expect(posDia).toBeGreaterThan(-1);
    expect(posGrupo).toBeGreaterThan(-1);
    expect(posDia).toBeLessThan(posGrupo);
    // Con rango explicito no entran: no se puede afirmar que caigan dentro.
    const ranged = renderTimeline(mezcla, { from: '2026-10-01', to: '2026-10-31' });
    expect(ranged?.inRange).toBe(1);
    expect(ranged?.body).not.toContain('[u1]');
    expect(ranged?.body).not.toContain('fecha desconocida');
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

  it('CAP multi-dia: descarta los dias mas antiguos primero y la cola da recuento y cursor', () => {
    const base = Date.UTC(2026, 9, 14); // 2026-10-14, fecha real
    const many: MemoryEntry[] = [];
    for (let k = 59; k >= 0; k--) {
      many.push(entry(`d${k}`, iso(base - k * DAY_MS), `dia ${k}: ${'z'.repeat(200)}`));
    }
    const r = renderTimeline(many);
    expect(r).not.toBeNull();
    expect((r?.body ?? '').length).toBeLessThanOrEqual(TIMELINE_CAP);
    expect(r?.inRange).toBe(60);
    expect(r?.hiddenByCap).toBeGreaterThan(0);
    expect(r?.body).toContain(`${r?.hiddenByCap} entradas sin mostrar por el límite`);
    expect(r?.body).toContain(`cursor="${r?.nextCursor}"`);
    expect(r?.body).toContain('entre 2026-08-16 y 2026-10-14');
    // El dia mas reciente siempre sobrevive; el mas antiguo cae primero.
    expect(r?.body).toContain('2026-10-14 (1):');
    expect(r?.body).not.toContain('2026-08-16 (1):');
    // Siguiendo el cursor se alcanza TODO lo oculto, pagina a pagina.
    let total = (r?.body.match(/^- \[d/gm) ?? []).length;
    let cursor = r?.nextCursor ?? undefined;
    for (let page = 0; cursor && page < 10; page++) {
      const next = renderTimeline(many, { cursor });
      expect(next).not.toBeNull();
      total += (next?.body.match(/^- \[d/gm) ?? []).length;
      cursor = next?.nextCursor ?? undefined;
    }
    expect(cursor).toBeUndefined();
    expect(total).toBe(60);
  });

  it('CANARIO auditor #137: 50 entradas el MISMO dia, recorte por filas + paginas exactas', () => {
    const sameDay: MemoryEntry[] = [];
    for (let i = 0; i < 50; i++) {
      sameDay.push(
        entry(`e${String(i).padStart(2, '0')}`, '2026-10-15', `nota ${i} del mismo dia`),
      );
    }
    const cap = 1200;
    const seenIds: string[] = [];
    let cursor: string | undefined;
    let firstHidden = -1;
    let pages = 0;
    for (;;) {
      const r = renderTimeline(sameDay, { cap, cursor });
      expect(r).not.toBeNull();
      pages++;
      expect(pages).toBeLessThan(10);
      expect(r?.inRange).toBe(50);
      expect((r?.body ?? '').length).toBeLessThanOrEqual(cap);
      const rows = (r?.body ?? '').split('\n').filter((l) => l.startsWith('- [e'));
      for (const row of rows) {
        // Fila completa, NUNCA partida: id y texto enteros en cada fila visible.
        expect(row).toMatch(/^- \[e\d{2}\] #gym nota \d+ del mismo dia$/);
        seenIds.push(/^- \[(e\d{2})\]/.exec(row)?.[1] ?? '');
      }
      if (pages === 1) {
        firstHidden = r?.hiddenByCap ?? -1;
        expect(firstHidden).toBe(50 - rows.length);
        expect(r?.nextCursor).toBe(`2026-10-15:${rows.length}`);
        expect(r?.body).toContain(`${firstHidden} entradas sin mostrar`);
        // Reciente primero: la primera fila de la primera pagina es e49.
        expect(rows[0]).toContain('[e49]');
      }
      if (!r?.nextCursor) {
        expect(r?.hiddenByCap).toBe(0);
        break;
      }
      cursor = r.nextCursor;
    }
    // Sumas exactas: todas las filas alcanzables, reciente primero, sin duplicar.
    expect(seenIds).toHaveLength(50);
    expect(seenIds).toEqual(sameDay.map((e) => e.id).reverse());
    expect(seenIds[0]).toBe('e49');
    expect(seenIds[49]).toBe('e00');
    expect(pages).toBeGreaterThan(1);
  });

  it('CANARIO auditor #137 r3: 100 tags de 31c - fila compacta, cap duro, id y marca intactos', () => {
    const tags = Array.from({ length: 100 }, (_, i) => `t${String(i).padStart(30, '0')}`);
    expect(tags[0]).toHaveLength(31);
    const e: MemoryEntry = {
      id: 'big',
      date: '2026-10-15',
      text: 'entrada con muchos tags',
      tags,
      supersedes: [],
      supersededBy: 'repl',
    };
    for (const cap of [TIMELINE_CAP, 1200]) {
      const r = renderTimeline([e], { cap });
      expect(r).not.toBeNull();
      expect((r?.body ?? '').length).toBeLessThanOrEqual(cap);
      expect(r?.hiddenByCap).toBe(0);
      expect(r?.nextCursor).toBeNull();
      const row = (r?.body ?? '').split('\n').find((l) => l.includes('[big]')) ?? '';
      expect(row.startsWith('- [big]')).toBe(true);
      expect(row).toContain('SUSTITUIDA→[repl]');
      expect(row).toContain('…');
      expect(row).toContain('tags)');
    }
  });

  it('cursor gastado o malformado: null (la tool responde "fin de la historia")', () => {
    expect(renderTimeline(ENTRIES, { cursor: '2026-10-01:2' })).toBeNull();
    expect(renderTimeline(ENTRIES, { cursor: 'no-es-cursor' })).toBeNull();
    expect(renderTimeline(ENTRIES, { cursor: '2026-02-31:1' })).toBeNull();
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

describe('9c r2: validacion y paginacion a traves de la tool (auditor #137)', () => {
  const SCOPE = 'tl2:test#main';
  let memory: MemoryStore;

  beforeEach(() => {
    memory = new MemoryStore(mkdtempSync(join(FACTORY_TEST_STATE_DIR, 'tl2-')));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rechaza fechas imposibles, rangos invertidos y cursores malformados con error explicito', async () => {
    const tool = createMemoryTool(memory, () => SCOPE);
    await expect(tool.execute('v1', { action: 'timeline', from: '2026-02-31' })).rejects.toThrow(
      /fecha real/,
    );
    await expect(tool.execute('v2', { action: 'timeline', to: '2026-13-01' })).rejects.toThrow(
      /fecha real/,
    );
    await expect(
      tool.execute('v3', { action: 'timeline', from: '2026-10-10', to: '2026-10-01' }),
    ).rejects.toThrow(/rango inválido/);
    await expect(tool.execute('v4', { action: 'timeline', cursor: 'pagina2' })).rejects.toThrow(
      /cursor/,
    );
    await expect(
      tool.execute('v5', { action: 'timeline', cursor: '2026-02-31:4' }),
    ).rejects.toThrow(/cursor/);
  });

  it('E2E: 90 notas el mismo dia se recorren ENTERAS por cursor, sin perder ni repetir', async () => {
    for (let i = 0; i < 90; i++) {
      memory.remember(SCOPE, `nota ${i}: ${'contenido'.repeat(6)}`);
    }
    const tool = createMemoryTool(memory, () => SCOPE);
    const seen = new Set<string>();
    let cursor: string | undefined;
    let firstDetails: { nextCursor: string | null; hiddenByCap: number; count: number } | null =
      null;
    let lastHidden = -1;
    for (let page = 0; page < 12; page++) {
      const r = await tool.execute(`p${page}`, {
        action: 'timeline',
        ...(cursor ? { cursor } : {}),
      });
      const text = textOf(r);
      expect(text.length).toBeLessThanOrEqual(TIMELINE_CAP);
      const d = r.details as { nextCursor: string | null; hiddenByCap: number; count: number };
      if (page === 0) firstDetails = d;
      lastHidden = d.hiddenByCap;
      for (const m of text.matchAll(/^- \[([^\]]+)\]/gm)) {
        if (m[1]) seen.add(m[1]);
      }
      if (!d.nextCursor) break;
      cursor = d.nextCursor;
    }
    expect(seen.size).toBe(90);
    expect(firstDetails?.count).toBe(90);
    expect(firstDetails?.hiddenByCap ?? 0).toBeGreaterThan(0);
    expect(lastHidden).toBe(0);
  });
});
