#!/usr/bin/env node
/**
 * Benchmark real del enrutador web: mide latencia y contenido de cada backend
 * con llamadas reales, y escribe la tabla en docs/web-router-bench.md.
 *
 * Uso:
 *   node scripts/bench-web.mjs                 # solo backends sin clave (directo, ddg)
 *   TINYFISH_API_KEY=... node scripts/bench-web.mjs   # incluye la pata TinyFish
 *
 * La clave NUNCA se imprime ni se guarda: solo va en la cabecera X-API-Key.
 */
import { writeFile } from 'node:fs/promises';
import {
  createDirectFetchBackend,
  createDuckDuckGoBackend,
  createTinyfishBackend,
} from '../dist/web/backends.js';

const key = process.env.TINYFISH_API_KEY?.trim();
const backends = [createDirectFetchBackend(), createDuckDuckGoBackend()];
if (key) backends.splice(1, 0, createTinyfishBackend({ apiKey: key }));

const SEARCH_QUERIES = [
  'horario renfe madrid barcelona manana',
  'precio asts spacemobile accion',
  'github earendil pi agent framework',
];
const FETCH_URLS = [
  'https://example.com/',
  'https://es.wikipedia.org/wiki/Asturias',
  'https://www.filmaffinity.com/es/film809297.html',
];

async function measure(fn) {
  const started = performance.now();
  try {
    const r = await fn();
    // chars ENTREGADOS (post-truncado): para fetch es r.text.length; para
    // search, la suma titulo+snippet que ya calcula el backend (r.chars).
    const chars = typeof r.text === 'string' ? r.text.length : (r.chars ?? 0);
    return { ok: true, ms: Math.round(performance.now() - started), chars, items: r.items?.length };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - started), error: String(err?.message ?? err).slice(0, 80) };
  }
}

/** Mediana estadistica (media de los dos centrales si hay un numero par). */
function median(sorted) {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

const rows = [];
for (const b of backends) {
  if (b.search) {
    for (const q of SEARCH_QUERIES) {
      const m = await measure(() => b.search(q, { maxResults: 5 }));
      rows.push({ op: 'search', backend: b.id, input: q, ...m });
    }
  }
  if (b.fetch) {
    for (const u of FETCH_URLS) {
      const m = await measure(() => b.fetch(u, { maxChars: 20_000 }));
      rows.push({ op: 'fetch', backend: b.id, input: u, ...m });
    }
  }
}

const byBackend = {};
for (const r of rows) {
  const k = `${r.op}:${r.backend}`;
  (byBackend[k] ??= []).push(r);
}
const summary = Object.entries(byBackend).map(([k, list]) => {
  const ok = list.filter((r) => r.ok);
  const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
  const med = median(lat);
  return {
    op: k.split(':')[0],
    backend: k.split(':')[1],
    n: list.length,
    ok: ok.length,
    medianaMs: med,
    charsMedios: ok.length ? Math.round(ok.reduce((s, r) => s + (r.chars ?? 0), 0) / ok.length) : 0,
  };
});

const fecha = new Date().toISOString().slice(0, 10);
const md = [
  `# Benchmark enrutador web — ${fecha} (real, no simulado)`,
  '',
  `Clave TinyFish: ${key ? 'SI (vault)' : 'NO — pata TinyFish sin medir'}. Entorno: CI/sandbox Linux, red saliente estandar. chars = texto entregado tras el truncado de 20k de la lectura; latencia = mediana estadistica.`,
  '',
  '| op | backend | llamadas | ok | latencia mediana (ms) | chars entregados medios |',
  '|---|---|---|---|---|---|',
  ...summary.map((s) => `| ${s.op} | ${s.backend} | ${s.n} | ${s.ok} | ${s.medianaMs ?? '—'} ms | ${s.charsMedios} |`),
  '',
  'Detalle por llamada:',
  '',
  ...rows.map(
    (r) =>
      `- ${r.op} ${r.backend} ${r.input}: ${r.ok ? `ok en ${r.ms} ms (${r.chars ?? 0} chars${r.items ? `, ${r.items} resultados` : ''})` : `FALLO en ${r.ms} ms: ${r.error}`}`,
  ),
  '',
].join('\n');

await writeFile(new URL('../docs/web-router-bench.md', import.meta.url), md, 'utf8');
console.log(md);
