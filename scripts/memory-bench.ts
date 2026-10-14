/**
 * C2 (item 9, PR 9a ronda 2): harness de medición del patrón índice →
 * timeline → detalle. NO cambia comportamiento.
 *
 * Corpus sintético determinista, declarado (no memoria real de Nico:
 * privacidad + reproducibilidad): 60 entradas largas (300-600 chars) en 5
 * temas con solape de vocabulario a propósito. Tres correcciones: una antigua
 * (factura recibo 2), una media (cena día 8) y una RECIENTE (gym semana 12)
 * — la reciente rompe la falsa equivalencia entre "filtrar superadas" y la
 * ventana de 20 (auditor 9a r2).
 *
 * Ground truth: cada consulta declara su CONJUNTO de ids relevantes y, en las
 * temáticas, un target designado bajo empate. El bench NO afirma que el
 * target sea "el hecho correcto": la métrica se llama target-hit y mide el
 * comportamiento del desempate por recencia. test/memory-bench.test.ts
 * valida las etiquetas (reciente = máx índice del conjunto, antiguo = mín).
 *
 * El render "HOY" reproduce EXACTAMENTE buildContextNote en este SHA:
 * memory.all(scope).slice(-20) SIN filtrar supersededBy (auditor 9a r2). Las
 * variantes propuestas (índice/híbrido) sí filtran, y eso se declara.
 *
 * Librería pura; runner: npx vitest run test/memory-bench.test.ts
 * (node --experimental-strip-types no resuelve los specifiers .js del repo).
 */
import { performance } from 'node:perf_hooks';
import type { MemoryEntry, MemoryStore } from '../src/memory.js';

const SNIPPET = 80;

interface Seed {
  text: string;
  tags: string[];
}

// Índices base por tema dentro de corpus(): factura 0,5,...; gym 1,6,...;
// familia 2,7,...; trabajo 3,8,...; banco 4,9,...
const themeIdx = (offset: number) => Array.from({ length: 12 }, (_, m) => offset + 5 * m);
const FACTURA = themeIdx(0);
const GYM = themeIdx(1);
const FAMILIA = themeIdx(2);
const TRABAJO = themeIdx(3);
const BANCO = themeIdx(4);

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

export interface Query {
  q: string;
  /** Posiciones en corpus() de TODAS las entradas relevantes (ground truth). */
  relevantIdx: number[];
  /** Posición del target designado bajo empate (solo métrica target-hit). */
  targetIdx?: number;
  caso: 'unico' | 'reciente' | 'antiguo';
}

export const QUERIES: Query[] = [
  { q: 'recibo 7 de la luz', relevantIdx: [30], caso: 'unico' },
  {
    q: 'subida de la factura de la luz',
    relevantIdx: FACTURA.filter((i) => i !== 5),
    targetIdx: 0,
    caso: 'antiguo',
  },
  { q: 'comisión del banco', relevantIdx: BANCO, targetIdx: 59, caso: 'reciente' },
  {
    q: 'cuánto levanto en press banca',
    relevantIdx: GYM.filter((i) => i !== 1 && i !== 56),
    targetIdx: 51,
    caso: 'reciente',
  },
  {
    q: 'cena con Marta',
    relevantIdx: FAMILIA.filter((i) => i !== 7 && i !== 37),
    targetIdx: 2,
    caso: 'antiguo',
  },
  {
    q: 'prioridad del sprint informe trimestral',
    relevantIdx: TRABAJO,
    targetIdx: 3,
    caso: 'antiguo',
  },
  { q: 'reclamar comisión de la cuenta', relevantIdx: BANCO, targetIdx: 4, caso: 'antiguo' },
  {
    q: 'italiano del barrio con Marta',
    relevantIdx: FAMILIA.filter((i) => i !== 7 && i !== 37),
    targetIdx: 57,
    caso: 'reciente',
  },
  {
    q: 'descansos del entrenamiento',
    relevantIdx: GYM.filter((i) => i !== 1 && i !== 56),
    targetIdx: 6,
    caso: 'antiguo',
  },
  { q: 'informe trimestral del trabajo', relevantIdx: TRABAJO, targetIdx: 58, caso: 'reciente' },
  {
    q: 'último recibo de casa',
    relevantIdx: FACTURA.filter((i) => i !== 5),
    targetIdx: 55,
    caso: 'reciente',
  },
  {
    q: 'comisiones y reclamaciones del banco',
    relevantIdx: BANCO,
    targetIdx: 59,
    caso: 'reciente',
  },
];

const SNIP = (t: string) => (t.length > SNIPPET ? `${t.slice(0, SNIPPET)}…` : t);

/**
 * Render BASELINE idéntico a buildContextNote en este SHA:
 * memory.all(scope).slice(-20), SIN filtrar superadas (auditor 9a r2). El
 * caller pasa store.all(scope) en crudo.
 */
export function renderBaselineHoy(allEntries: MemoryEntry[]): string {
  return allEntries
    .slice(-20)
    .map((e) => `- ${e.text}`)
    .join('\n');
}

/** Variantes PROPUESTAS: sí filtran superadas (diferencia declarada). */
export function renderIndex(entries: MemoryEntry[]): string {
  return entries
    .filter((e) => e.supersededBy === null)
    .map((e) => `- [${e.id}] (${e.date}) ${e.tags.map((t) => `#${t}`).join(' ')} ${SNIP(e.text)}`)
    .join('\n');
}

export function renderHybrid(entries: MemoryEntry[], n: number): string {
  const active = entries.filter((e) => e.supersededBy === null);
  const window = active.slice(-20);
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
  modes: { name: string; chars: number }[];
}

export function runBench(store: MemoryStore, scope = 'bench:corpus#main'): BenchResult {
  const seeds = corpus();
  const ids: string[] = [];
  for (const s of seeds) ids.push(store.remember(scope, s.text, { tags: s.tags }).id);
  // Tres correcciones, cada una sobre SU entidad (auditor 9a r2): la factura
  // del recibo 2 (índice 5), la cena del día 8 (índice 37) y —reciente a
  // propósito— la semana 12 de banca (índice 56).
  store.supersede(
    scope,
    ids[5] ?? '',
    'La factura de la luz del recibo 2 quedó anulada por error de lectura del contador',
    { tags: ['facturas', 'casa'] },
  );
  store.supersede(scope, ids[37] ?? '', 'Cena con Marta del día 8 cancelada, quedamos otro día', {
    tags: ['familia', 'planes'],
  });
  store.supersede(
    scope,
    ids[56] ?? '',
    'Corrección de la semana 12: press banca 53 kg reales, no 52',
    { tags: ['gym', 'salud'] },
  );

  const all = store.all(scope); // baseline: en crudo, como el CLI real
  const activeEntries = all.filter((e) => e.supersededBy === null).length;
  const idOf = (idx: number) => ids[idx] ?? '';

  const runs = 5;
  const hitAny = new Array<boolean>(QUERIES.length).fill(false);
  const hitTarget = new Array<boolean>(QUERIES.length).fill(false);
  const latencies: number[] = [];
  for (let r = 0; r < runs; r++) {
    QUERIES.forEach((query, i) => {
      const t0 = performance.now();
      const found = store.recall(scope, query.q, 5).map((e) => e.id);
      if (r === 0) {
        const relevantIds = query.relevantIdx.map(idOf);
        hitAny[i] = found.some((id) => relevantIds.includes(id));
        hitTarget[i] = query.targetIdx !== undefined && found.includes(idOf(query.targetIdx));
      }
      if (r > 0) latencies.push(performance.now() - t0); // primera (fría) descartada
    });
  }
  const frac = (xs: boolean[]) => xs.filter(Boolean).length / xs.length;
  const targetIdxs = QUERIES.map((q, i) => (q.targetIdx !== undefined ? i : -1)).filter(
    (i) => i >= 0,
  );
  const targetOf = (caso: 'reciente' | 'antiguo') =>
    frac(targetIdxs.filter((i) => QUERIES[i]?.caso === caso).map((i) => hitTarget[i] ?? false));

  const modes = [
    {
      name: 'full HOY = CLI real (ventana 20, INCLUYE superadas)',
      text: renderBaselineHoy(all),
    },
    { name: 'índice propuesto (ventana 20, filtra superadas)', text: renderIndex(all.slice(-20)) },
    { name: 'índice amplio (todas las activas)', text: renderIndex(all) },
    { name: 'híbrido 5 completas + 15 índice', text: renderHybrid(all, 5) },
    { name: 'híbrido 10 completas + 10 índice', text: renderHybrid(all, 10) },
  ];

  const lines = [
    '| modo | contexto (chars) | tokens est. (chars/4) |',
    '| --- | ---: | ---: |',
    ...modes.map((m) => `| ${m.name} | ${m.text.length} | ${Math.round(m.text.length / 4)} |`),
    '',
    `hit-any@5 (12 consultas, conjunto relevante declarado): ${(frac(hitAny) * 100).toFixed(1)}%`,
    `target-hit@5 bajo empate (11 temáticas): ${(frac(targetIdxs.map((i) => hitTarget[i] ?? false)) * 100).toFixed(1)}%`,
    `  target reciente (6): ${(targetOf('reciente') * 100).toFixed(1)}% | target antiguo (5): ${(targetOf('antiguo') * 100).toFixed(1)}%`,
    `latencia recall mediana: ${median(latencies).toFixed(2)} ms (${latencies.length} mediciones, primera fría descartada)`,
    `entradas totales: ${all.length} (activas ${activeEntries}; 3 superadas: 2 antiguas/medias + 1 RECIENTE)`,
  ];
  return {
    table: lines.join('\n'),
    hitAnyAt5: frac(hitAny),
    targetHitAt5: frac(targetIdxs.map((i) => hitTarget[i] ?? false)),
    targetHitRecientes: targetOf('reciente'),
    targetHitAntiguos: targetOf('antiguo'),
    medianMs: median(latencies),
    activeEntries,
    modes: modes.map((m) => ({ name: m.name, chars: m.text.length })),
  };
}
