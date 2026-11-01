/**
 * `pa doctor` en castellano llano. Las comprobaciones vienen de muchos sitios
 * (cli.ts, shell-sandbox, panel, mcp…) y varias llevaban la etiqueta en inglés
 * («provider key», «browser FALTA», «verify actions»). Aquí se traduce la etiqueta
 * de cada línea al final, sin tocar cada comprobación ni lo que dice detrás.
 */

/** Ancho de la etiqueta en cada línea de `pa doctor` (la columna de valores). */
const WIDTH = 16;

const LABELS: Readonly<Record<string, string>> = {
  'state dir': 'datos',
  vault: 'claves',
  'provider key': 'clave modelo',
  shell: 'consola',
  screen: 'pantalla',
  screenshot: 'captura',
  'screen video': 'vídeo pantalla',
  'voice stt': 'voz (oír)',
  'voice tts': 'voz (hablar)',
  camera: 'cámara',
  microphone: 'micrófono',
  'wake word': 'palabra clave',
  desktop: 'escritorio',
  'shell sandbox': 'consola aislada',
  docker: 'docker',
  'sandbox image': 'imagen aislada',
  browser: 'navegador',
  cron: 'programadas',
  'verify actions': 'comprobar',
  'open windows': 'ventanas',
  'panel hosts': 'panel nombres',
  'mcp http': 'mcp web',
};

/** Valores sueltos en inglés al principio del valor. */
const VALUES: ReadonlyArray<readonly [RegExp, string]> = [[/^off\b/, 'apagado']];

/** Traduce la etiqueta (y un «off» inicial) de una línea de `pa doctor`. */
export function doctorLineEs(line: string): string {
  const m = /^([a-z][a-z ]*?) {2,}(\S.*)$/.exec(line);
  if (!m) return line;
  const label = m[1] ?? '';
  let value = m[2] ?? '';
  for (const [re, to] of VALUES) value = value.replace(re, to);
  const es = LABELS[label];
  if (es === undefined) return line.slice(0, line.length - (m[2] ?? '').length) + value;
  return `${es.padEnd(WIDTH - 1)} ${value}`;
}

export function doctorLinesEs(lines: readonly string[]): string[] {
  return lines.map(doctorLineEs);
}
