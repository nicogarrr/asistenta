/**
 * `pa doctor`: claves PA_* del .env que Asistenta no conoce. Una errata
 * («pa_web_prot=8787») se ignora sin aviso y el ajuste no se aplica. La lista
 * buena es .env.example (el instalador lo copia como .env; test/env-example
 * comprueba que documenta todo lo que se lee). Solo se nombra la clave.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { envFileText } from './env-text.js';
import { dotEnvFiles } from './envfile.js';

const KEY = /^\s*(?:export\s+)?(PA_[A-Za-z0-9_]+)\s*=/;
// Prefijos dinámicos: PA_SECRET_<NOMBRE>, PA_DIAG_END_<id>.
const DYNAMIC = /^PA_(SECRET|DIAG_END)_/;

/** Nombres PA_* que aparecen en un texto (también en líneas comentadas). */
export function knownEnvKeys(exampleText: string): Set<string> {
  return new Set([...exampleText.matchAll(/\bPA_[A-Z0-9_]*[A-Z0-9]\b/g)].map((m) => m[0]));
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j] ?? 0;
      row[j] = Math.min(keep + 1, (row[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length] ?? 0;
}

/** El nombre conocido más parecido (a 2 letras como mucho), si lo hay. */
export function closestEnvKey(name: string, known: Set<string>): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  for (const k of known) {
    const d = distance(name.toUpperCase(), k);
    if (d < bestD) {
      best = k;
      bestD = d;
    }
  }
  return best;
}

/** Claves PA_* puestas en el texto de un .env que no están en `known`. */
export function unknownEnvKeys(envText: string, known: Set<string>): string[] {
  const out: string[] = [];
  for (const line of envText.split(/\r?\n/)) {
    const key = KEY.exec(line)?.[1];
    if (!key || known.has(key) || DYNAMIC.test(key) || out.includes(key)) continue;
    out.push(key);
  }
  return out;
}

const read = (file: string) => {
  try {
    return envFileText(readFileSync(file));
  } catch {
    return undefined;
  }
};

/** Línea de `pa doctor` solo si el .env tiene claves PA_* desconocidas. */
export function envUnknownKeysDoctorLine(
  files: string[] = dotEnvFiles(),
  example: string = fileURLToPath(new URL('../.env.example', import.meta.url)),
): string | undefined {
  const exampleText = read(example);
  if (exampleText === undefined) return undefined;
  const known = knownEnvKeys(exampleText);
  const bad: string[] = [];
  for (const file of files) {
    const text = read(file);
    if (text === undefined) continue;
    for (const k of unknownEnvKeys(text, known)) if (!bad.includes(k)) bad.push(k);
  }
  if (bad.length === 0) return undefined;
  const shown = bad.slice(0, 5).map((k) => {
    const near = closestEnvKey(k, known);
    return near ? `${k} (¿querías decir ${near}?)` : k;
  });
  const more = bad.length > 5 ? ` y ${bad.length - 5} más` : '';
  return `ajustes         no conozco ${shown.join(', ')}${more}: así no se aplica`;
}
