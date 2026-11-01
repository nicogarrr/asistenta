/**
 * `pa doctor`: líneas del .env que Node lee distinto de lo que parece.
 * - «PA_WEB_PORT: 8787» o «PA_WEB_PORT 8787» (sin «=»): la línea se ignora entera.
 * - La misma clave dos veces: vale la última, y editar la primera no hace nada.
 * - Comillas tipográficas (“…” o «…», al copiar del móvil o de Word) o una
 *   comilla sin cerrar: las comillas acaban dentro del valor.
 * Solo se nombra la clave; el valor nunca se muestra.
 */
import { readFileSync } from 'node:fs';
import { envFileText } from './env-text.js';
import { dotEnvFiles } from './envfile.js';

const ASSIGN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/;
const NO_EQUALS = /^\s*(?:export\s+)?(PA_[A-Z0-9_]+)\s*(?::|\s)\s*\S/;

export function envLineProblems(text: string): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  const add = (msg: string) => {
    if (!out.includes(msg)) out.push(msg);
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = ASSIGN.exec(line);
    if (!m) {
      const key = NO_EQUALS.exec(line)?.[1];
      if (key) add(`${key} (falta el «=»: escribe ${key}=valor)`);
      continue;
    }
    const key = m[1] ?? '';
    const value = m[2] ?? '';
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (/^[“”«»‘’]/.test(value)) add(`${key} (comillas de móvil o Word: usa comillas rectas ")`);
    else {
      const q = value[0];
      if ((q === '"' || q === "'") && value.indexOf(q, 1) < 0)
        add(`${key} (falta cerrar la comilla)`);
    }
  }
  for (const [key, n] of seen) if (n > 1) add(`${key} (está ${n} veces; vale la última)`);
  return out;
}

/** Línea de `pa doctor` solo si alguna línea del .env no se lee como parece. */
export function envLinesDoctorLine(files: string[] = dotEnvFiles()): string | undefined {
  const problems: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = envFileText(readFileSync(file));
    } catch {
      continue;
    }
    for (const p of envLineProblems(text)) if (!problems.includes(p)) problems.push(p);
  }
  if (problems.length === 0) return undefined;
  return `.env            revisa ${problems.slice(0, 5).join(', ')}`;
}
