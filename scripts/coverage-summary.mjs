/** Convierte coverage/coverage-summary.json (vitest, reporter json-summary) en una tabla
 * Markdown para el resumen del job de CI. Sin el fichero no falla: lo dice y sale con 0,
 * porque un test rojo ya hace fallar el paso anterior y aquí solo se informa.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const METRICS = [
  ['lines', 'Líneas'],
  ['statements', 'Sentencias'],
  ['functions', 'Funciones'],
  ['branches', 'Ramas'],
];

export function coverageMarkdown(summary) {
  const total = summary?.total;
  if (!total) return '### Cobertura\n\nSin datos de cobertura.\n';
  const rows = METRICS.map(([key, label]) => {
    const m = total[key] ?? { pct: 0, covered: 0, total: 0 };
    return `| ${label} | ${Number(m.pct).toFixed(2)} % | ${m.covered} / ${m.total} |`;
  });
  return [
    '### Cobertura (src/)',
    '',
    '| Métrica | % | Cubiertas / total |',
    '|---|---:|---:|',
    ...rows,
    '',
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2] ?? 'coverage/coverage-summary.json';
  if (!existsSync(file)) {
    console.log(`### Cobertura\n\nNo se generó ${file}.\n`);
  } else {
    console.log(coverageMarkdown(JSON.parse(readFileSync(file, 'utf8'))));
  }
}
