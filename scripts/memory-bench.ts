/**
 * C2 (item 9, PR 9a): harness de medición del patrón índice → timeline →
 * detalle. NO cambia comportamiento: mide el render ACTUAL (texto completo de
 * las últimas 20) y proyecta índice puro e híbrido sobre el MISMO corpus.
 *
 * Corpus sintético determinista, declarado: no usa la memoria real de Nico
 * (privacidad + reproducibilidad). 60 entradas en 5 temas con solape de
 * vocabulario a propósito y entradas largas (300-600 chars, hacia donde crece
 * la memoria real), 2 superadas, y 12 consultas con id relevante conocido:
 * 6 apuntan al hecho RELEVANTE MÁS RECIENTE (el desempate actual favorece
 * recencia) y 6 al MÁS ANTIGUO entre empatados (el peor caso).
 *
 * Librería pura: el runner es test/memory-bench.test.ts (vitest resuelve los
 * specifiers .js internos del repo; node --experimental-strip-types no).
 * Reproducir los números: npx vitest run test/memory-bench.test.ts
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

/**
 * Consulta -> índice (0-based) de la entrada relevante en corpus(). Mezcla
 * declarada: 6 relevantes recientes (caso favorable al desempate actual) y 6
 * antiguas (el hecho correcto envejecido entre ruido similar).
 */
export const QUERIES: { q: string; expect: number; caso: 'reciente' | 'antiguo' }[] = [
  { q: 'cuánto subió la factura de la luz', expect: 0, caso: 'antiguo' },
  { q: 'comisión del banco', expect: 4, caso: 'antiguo' },
  { q: 'cuánto levanto ahora en press banca', expect: 56, caso: 'reciente' },
  { q: 'dónde cené con Marta la última vez', expect: 57, caso: 'reciente' },
  { q: 'prioridad del sprint informe', expect: 3, caso: 'antiguo' },
  { q: 'reclamar comisión de la cuenta', expect: 59, caso: 'reciente' },
  { q: 'recibo de la luz del segundo semestre', expect: 30, caso: 'antiguo' },
  { q: 'descansos del entrenamiento', expect: 6, caso: 'antiguo' },
  { q: 'italiano del barrio con Marta', expect: 12, caso: 'antiguo' },
  { q: 'informe trimestral del trabajo', expect: 58, caso: 'reciente' },
  { q: 'última factura de casa recibo', expect: 55, caso: 'reciente' },
  { q: 'banca kg por semana', expect: 11, caso: 'reciente' },
];

const SNIP = (t: string) => (t.length > SNIPPET ? `${t.slice(0, SNIPPET)}…` : t);

/** Render ACTUAL (buildContextNote): la ventana de las últimas 20 a texto completo. */
export function renderFull(entries: MemoryEntry[]): string {
  return entries
    .slice(-20)
    .map((e) => `- ${e.text}`)
    .join('\n');
}

/** Índice: una línea compacta por entrada. La comparación honesta es sobre la
 *  MISMA ventana de 20; el de 60 líneas mide además lo que costaría ampliar la
 *  ventana cuando el índice lo hace barato. */
export function renderIndex(entries: MemoryEntry[]): string {
  return entries
    .map((e) => `- [${e.id}] (${e.date}) ${e.tags.map((t) => `#${t}`).join(' ')} ${SNIP(e.text)}`)
    .join('\n');
}

/** Híbrido (variante sugerida en revisión): dentro de la ventana de 20,
 *  últimas n completas + índice de las demás. */
export function renderHybrid(entries: MemoryEntry[], n: number): string {
  const window = entries.slice(-20);
  const recent = window.slice(-n);
  const rest = window.slice(0, -n);
  return `${renderIndex(rest)}\n${renderFull(recent)}`;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

export interface BenchResult {
  table: string;
  recallAt5: number;
  recallRecientes: number;
  recallAntiguos: number;
  medianMs: number;
  activeEntries: number;
  modes: { name: string; chars: number }[];
}

export function runBench(store: MemoryStore, scope = 'bench:corpus#main'): BenchResult {
  const seeds = corpus();
  const ids: string[] = [];
  for (const s of seeds) ids.push(store.remember(scope, s.text, { tags: s.tags }).id);
  // Dos correcciones reales: las superadas NO deben aparecer en ningún nivel.
  store.supersede(
    scope,
    ids[1] ?? '',
    'La factura de la luz del recibo 2 quedó anulada por error de lectura',
    { tags: ['facturas', 'casa'] },
  );
  store.supersede(scope, ids[7] ?? '', 'Cena con Marta del día 8 cancelada, quedamos otro día', {
    tags: ['familia', 'planes'],
  });

  const entries = store.all(scope).filter((e) => e.supersededBy === null);
  const expected = QUERIES.map(({ expect }) => ids[expect] ?? '');

  // recall@5: fracción de consultas cuyo id relevante aparece entre las 5 primeras.
  const runs = 5;
  const hit = new Array<boolean>(QUERIES.length).fill(false);
  const latencies: number[] = [];
  for (let r = 0; r < runs; r++) {
    QUERIES.forEach(({ q }, i) => {
      const t0 = performance.now();
      const found = store.recall(scope, q, 5).map((e) => e.id);
      if (r === 0) hit[i] = found.includes(expected[i] ?? '');
      if (r > 0) latencies.push(performance.now() - t0); // descarta la primera (fría)
    });
  }
  const recallAt5 = hit.filter(Boolean).length / QUERIES.length;
  const recallOf = (caso: 'reciente' | 'antiguo') => {
    const idx = QUERIES.map((q, i) => (q.caso === caso ? i : -1)).filter((i) => i >= 0);
    return idx.filter((i) => hit[i]).length / idx.length;
  };

  const modes = [
    { name: 'full (HOY: ventana 20 completas)', text: renderFull(entries) },
    { name: 'índice (misma ventana 20)', text: renderIndex(entries.slice(-20)) },
    { name: 'índice amplio (60 líneas)', text: renderIndex(entries) },
    { name: 'híbrido 5 completas + 15 índice', text: renderHybrid(entries, 5) },
    { name: 'híbrido 10 completas + 10 índice', text: renderHybrid(entries, 10) },
  ];

  const lines = [
    '| modo | contexto (chars) | tokens est. (chars/4) |',
    '| --- | ---: | ---: |',
    ...modes.map((m) => `| ${m.name} | ${m.text.length} | ${Math.round(m.text.length / 4)} |`),
    '',
    `recall@5 global (12 consultas): ${(recallAt5 * 100).toFixed(1)}%`,
    `recall@5 relevante reciente (6): ${(recallOf('reciente') * 100).toFixed(1)}%`,
    `recall@5 relevante antiguo (6): ${(recallOf('antiguo') * 100).toFixed(1)}%`,
    `latencia recall mediana: ${median(latencies).toFixed(2)} ms (${latencies.length} mediciones, primera fría descartada)`,
    `entradas activas: ${entries.length} (2 superadas excluidas de todo nivel)`,
  ];
  return {
    table: lines.join('\n'),
    recallAt5,
    recallRecientes: recallOf('reciente'),
    recallAntiguos: recallOf('antiguo'),
    medianMs: median(latencies),
    activeEntries: entries.length,
    modes: modes.map((m) => ({ name: m.name, chars: m.text.length })),
  };
}
