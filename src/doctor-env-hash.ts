/**
 * `pa doctor`: un «#» sin comillas dentro de un valor del .env lo corta ahí.
 * Node lee `PA_TELEGRAM_TOKEN=abc#def` como «abc» (el resto es comentario), así
 * que un token o una contraseña con «#» deja de funcionar sin ningún aviso.
 * Aquí solo se nombra la clave: el valor nunca se muestra.
 */
import { readFileSync } from 'node:fs';
import { envFileText } from './env-text.js';
import { dotEnvFiles } from './envfile.js';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=([ \t]*)(.*)$/;

/** Claves cuyo valor sin comillas lleva un «#» pegado al texto (y por tanto se corta). */
export function envHashCutKeys(text: string): string[] {
  const keys: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const [, key, gap, value] = m;
    if (!key || value === undefined || /^["'`]/.test(value)) continue;
    const at = value.indexOf('#');
    if (at < 0) continue;
    // «CLAVE=valor # comentario» es un comentario normal; «CLAVE=ab#cd» o «CLAVE=#ab» no.
    const cut = at === 0 ? gap === '' : !/\s/.test(value[at - 1] ?? ' ');
    if (cut && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Línea de `pa doctor` solo si algún valor del .env se corta en un «#». */
export function envHashDoctorLine(files: string[] = dotEnvFiles()): string | undefined {
  const keys: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = envFileText(readFileSync(file));
    } catch {
      continue;
    }
    for (const k of envHashCutKeys(text)) if (!keys.includes(k)) keys.push(k);
  }
  if (keys.length === 0) return undefined;
  const one = keys[0];
  return `.env            ${keys.join(', ')} ${keys.length === 1 ? 'lleva' : 'llevan'} un «#» sin comillas y se corta ahí: pon el valor entre comillas, p. ej. ${one}="…"`;
}
