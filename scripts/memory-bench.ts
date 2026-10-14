/**
 * C2 (item 9, PR 9a ronda 3): harness de medición del patrón índice →
 * timeline → detalle. NO cambia comportamiento.
 *
 * Corpus sintético determinista, declarado (no memoria real de Nico):
 * 60 seeds largas (300-600 chars) en 5 temas con solape + 3 correcciones
 * (factura recibo 2, cena día 8 y —reciente a propósito— gym semana 12).
 *
 * Ground truth DERIVADO del store real (auditor 9a r2/r3): cada consulta es
 * un predicado (tema o texto) y el conjunto relevante se calcula sobre las
 * entradas ACTIVAS del store — incluye los replacements y no puede quedar
 * ids excluidos por error. El target es el extremo del conjunto por posición
 * de inserción (reciente = último, antiguo = primero), medido como
 * target-hit SIN afirmar que sea "el hecho correcto".
 *
 * El render "HOY" reproduce EXACTAMENTE buildContextNote en este SHA:
 * memory.all(scope).slice(-20) SIN filtrar supersededBy. Las variantes
 * propuestas (índice/híbrido) filtran y trabajan con 20 ACTIVAS, y cada modo
 * declara su número de entradas en la tabla.
 *
 * Librería pura; runner: npx vitest run test/memory-bench.test.ts.
 */
import { performance } from 'node:perf_hooks';
import type { MemoryEntry, MemoryStore } from '../src/memory.js';

const SNIPPET = 80;

interface Seed {
  text: string;
  tags: string[];
}

export function corpus(): Seed[] {
  const seeds: Seed[] = [];
  const push = (text: string, tags: string[]) => seeds.push({ text, tags });
  const detail = (tema: string, m: number) =>
    ` Lo anoto con detalle para encontrarlo luego: contexto de ${tema}, semana ${m}, con las cifras y matices que importan, porque cuando lo busque dentro de meses querré el cuadro completo y no solo el titular. Repito el dato clave en lenguaje natural y añado el porqué de la decisión que tomamos entonces.`;
  for (let m = 1; m <= 12; m++) {
    push(
      `La factura de la luz de ${m <= 6 ? 'primer' : 'segundo'} semestre, recibo ${m}: subió un ${m}% respecto al anterior.${detail('facturas de casa', m)}`,
      ['facturas', 'casa'],
    );
    push(
      `Entrenamiento semana ${m}: press banca ${40 + m} kg, series bien, descansos de dos minutos.${detail('el gimnasio', m)}`,
      ['gym', 'salud'],
    );
    push(
      `Cena con Marta el día ${m}: le gustó el italiano del barrio, pedimos lo de siempre.${detail('planes con Marta', m)}`,
      ['familia', 'planes'],
    );
    push(
      `Reunión de trabajo sprint ${m}: prioridad al informe trimestral y a cerrar las tareas abiertas.${detail('el trabajo', m)}`,
      ['trabajo'],
    );
    push(
      `El banco cobró comisión ${m}€ por la cuenta; reclamar si pasa de 5.${detail('comisiones del banco', m)}`,
      ['banco', 'dinero'],
    );
  }
  return seeds;
}

/** Las tres correcciones, cada una sobre SU entidad (índice del seed corregido). */
export const CORRECTIONS: { seedIdx: number; text: string; tags: string[] }[] = [
  {
    seedIdx: 5,
    text: 'La factura de la luz del recibo 2 quedó anulada por error de lectura del contador',
    tags: ['facturas', 'casa'],
  },
  {
    seedIdx: 37,
    text: 'Cena con Marta del día 8 cancelada, quedamos otro día',
    tags: ['familia', 'planes'],
  },
  {
    seedIdx: 56,
    text: 'Corrección de la semana 12: press banca 53 kg reales, no 52',
    tags: ['gym', 'salud'],
  },
];

export interface Query {
  q: string;
  /** Tema (tag) cuyas entradas ACTIVAS son todas relevantes. */
  theme?: string;
  /** O texto que identifica UNA entrada activa (caso unico). */
  text?: string;
  caso: 'unico' | 'reciente' | 'antiguo';
}

export const QUERIES: Query[] = [
  { q: 'recibo 7 de la luz', text: 'recibo 7', caso: 'unico' },
  { q: 'subida de la factura de la luz', theme: 'facturas', caso: 'antiguo' },
  { q: 'comisión del banco', theme: 'banco', caso: 'reciente' },
  { q: 'cuánto levanto en press banca', theme: 'gym', caso: 'reciente' },
  { q: 'cena con Marta', theme: 'familia', caso: 'antiguo' },
  { q: 'prioridad del sprint informe trimestral', theme: 'trabajo', caso: 'antiguo' },
  { q: 'reclamar comisión de la cuenta', theme: 'banco', caso: 'antiguo' },
  { q: 'italiano del barrio con Marta', theme: 'familia', caso: 'reciente' },
  { q: 'descansos del entrenamiento', theme: 'gym', caso: 'antiguo' },
  { q: 'informe trimestral del trabajo', theme: 'trabajo', caso: 'reciente' },
  { q: 'último recibo de casa', theme: 'facturas', caso: 'reciente' },
  { q: 'factura anulada por error de lectura', text: 'anulada por error', caso: 'unico' },
];

export function seedBench(store: MemoryStore, scope: string): void {
  const ids: string[] = [];
  for (const s of corpus()) ids.push(store.remember(scope, s.text, { tags: s.tags }).id);
  for (const c of CORRECTIONS) {
    store.supersede(scope, ids[c.seedIdx] ?? '', c.text, { tags: c.tags });
  }
}

export interface GroundTruth {
  q: string;
  caso: Query['caso'];
  /** Ids ACTIVOS relevantes, calculados del store real (replacements incluidos). */
  relevantIds: string[];
  /** Extremo por posición de inserción: reciente = último, antiguo = primero. */
  targetId: string | null;
}

/** Ground truth derivado: no hay lista de exclusiones que pueda quedar vieja. */
export function groundTruth(all: MemoryEntry[]): GroundTruth[] {
  const active = all.filter((e) => e.supersededBy === null);
  const pos = new Map(all.map((e, i) => [e.id, i]));
  return QUERIES.map((query) => {
    const relevant = query.text
      ? active.filter((e) => e.text.toLowerCase().includes(query.text ?? ''))
      : active.filter((e) => e.tags.includes(query.theme ?? ''));
    const relevantIds = relevant.map((e) => e.id);
    let targetId: string | null = null;
    if (query.caso === 'unico') targetId = relevantIds[0] ?? null;
    else if (relevant.length > 0) {
      const sorted = [...relevant].sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
      targetId =
        query.caso === 'reciente'
          ? (sorted[sorted.length - 1]?.id ?? null)
          : (sorted[0]?.id ?? null);
    }
    return { q: query.q, caso: query.caso, relevantIds, targetId };
  });
}

const SNIP = (t: string) => (t.length > SNIPPET ? `${t.slice(0, SNIPPET)}…` : t);

/** Render BASELINE idéntico a buildContextNote en este SHA:
 *  memory.all(scope).slice(-20), SIN filtrar superadas. */
export function renderBaselineHoy(allEntries: MemoryEntry[]): string {
  return allEntries
    .slice(-20)
    .map((e) => `- ${e.text}`)
    .join('\n');
}

/** Variantes PROPUESTAS: filtran superadas y trabajan con activas (declarado). */
export function renderIndex(activeEntries: MemoryEntry[]): string {
  return activeEntries
    .map((e) => `- [${e.id}] (${e.date}) ${e.tags.map((t) => `#${t}`).join(' ')} ${SNIP(e.text)}`)
    .join('\n');
}

export function renderHybrid(activeEntries: MemoryEntry[], n: number): string {
  const window = activeEntries.slice(-20);
  const recent = window.slice(-n);
  const rest = window.slice(0, -n);
  return `${renderIndex(rest)}\n${recent.map((e) => `- ${e.text}`).join('\n')}`;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

export interface BenchResult {
  table: string;
  hitAnyAt5: number;
  targetHitAt5: number;
  targetHitRecientes: number;
  targetHitAntiguos: number;
  medianMs: number;
  activeEntries: number;
  modes: { name: string; chars: number; entries: number }[];
}

export function runBench(store: MemoryStore, scope = 'bench:corpus#main'): BenchResult {
  seedBench(store, scope);
  const all = store.all(scope); // baseline: en crudo, como el CLI real
  const active = all.filter((e) => e.supersededBy === null);
  const gt = groundTruth(all);

  const runs = 5;
  const hitAny = new Array<boolean>(gt.length).fill(false);
  const hitTarget = new Array<boolean>(gt.length).fill(false);
  const latencies: number[] = [];
  for (let r = 0; r < runs; r++) {
    gt.forEach((query, i) => {
      const t0 = performance.now();
      const found = store.recall(scope, query.q, 5).map((e) => e.id);
      if (r === 0) {
        hitAny[i] = found.some((id) => query.relevantIds.includes(id));
        hitTarget[i] = query.targetId !== null && found.includes(query.targetId);
      }
      if (r > 0) latencies.push(performance.now() - t0); // primera (fría) descartada
    });
  }
  const frac = (xs: boolean[]) => xs.filter(Boolean).length / xs.length;
  const targetOf = (caso: 'reciente' | 'antiguo') => {
    const xs = gt.map((g, i) => (g.caso === caso ? (hitTarget[i] ?? false) : null));
    const flat = xs.filter((x): x is boolean => x !== null);
    return frac(flat);
  };

  const modes = [
    {
      name: 'full HOY = CLI real (20 raw, INCLUYE superadas)',
      text: renderBaselineHoy(all),
      entries: all.slice(-20).length,
    },
    {
      name: 'índice propuesto (20 activas, filtra superadas)',
      text: renderIndex(active.slice(-20)),
      entries: active.slice(-20).length,
    },
    {
      name: `índice amplio (${active.length} activas)`,
      text: renderIndex(active),
      entries: active.length,
    },
    { name: 'híbrido 5 completas + 15 índice', text: renderHybrid(active, 5), entries: 20 },
    { name: 'híbrido 10 completas + 10 índice', text: renderHybrid(active, 10), entries: 20 },
  ];

  const lines = [
    '| modo | entradas | contexto (chars) | tokens est. (chars/4) |',
    '| --- | ---: | ---: | ---: |',
    ...modes.map(
      (m) => `| ${m.name} | ${m.entries} | ${m.text.length} | ${Math.round(m.text.length / 4)} |`,
    ),
    '',
    `hit-any@5 (12 consultas, conjunto relevante derivado del store): ${(frac(hitAny) * 100).toFixed(1)}%`,
    `target-hit@5 bajo empate (12 consultas): ${(frac(hitTarget) * 100).toFixed(1)}%`,
    `  target reciente (5): ${(targetOf('reciente') * 100).toFixed(1)}% | target antiguo (5): ${(targetOf('antiguo') * 100).toFixed(1)}%`,
    `latencia recall mediana: ${median(latencies).toFixed(2)} ms (${latencies.length} mediciones, primera fría descartada)`,
    `entradas totales: ${all.length} (activas ${active.length}; 3 superadas: 2 antiguas/medias + 1 RECIENTE)`,
  ];
  return {
    table: lines.join('\n'),
    hitAnyAt5: frac(hitAny),
    targetHitAt5: frac(hitTarget),
    targetHitRecientes: targetOf('reciente'),
    targetHitAntiguos: targetOf('antiguo'),
    medianMs: median(latencies),
    activeEntries: active.length,
    modes: modes.map((m) => ({ name: m.name, chars: m.text.length, entries: m.entries })),
  };
}
