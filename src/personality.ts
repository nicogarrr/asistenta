/**
 * Personalidad de Asistenta, escrita por el dueño (como el SOUL.md de Hermes Agent).
 *
 * Si existe `<estado>/PERSONALIDAD.md`, su texto entra en el contexto de cada turno
 * del chat privado del dueño: tono, estilo, trato («háblame de tú», «respuestas
 * cortas», «con humor»). Es solo estilo: no cambia permisos ni aprobaciones, y pasa
 * por los mismos filtros que un skill importado o el ASISTENTA.md de un proyecto
 * (secretos, credenciales, frases de inyección). Se relee en cada turno, así que
 * editar el fichero vale sin reiniciar. Si no existe, está vacío, es demasiado
 * grande o no pasa el filtro, no entra nada.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './log.js';
import { paths } from './paths.js';
import { screenUntrustedText } from './skills/import.js';

export const PERSONALITY_FILE = 'PERSONALIDAD.md';
export const PERSONALITY_MAX_BYTES = 2 * 1024;

export function renderPersonality(dir: string = paths.state): string {
  const file = join(dir, PERSONALITY_FILE);
  let raw: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) return '';
    if (st.size > PERSONALITY_MAX_BYTES) {
      log.warn('PERSONALIDAD.md too big, ignored', { bytes: st.size, max: PERSONALITY_MAX_BYTES });
      return '';
    }
    raw = readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (!text) return '';
  const problem = screenUntrustedText(text);
  if (problem) {
    log.warn('PERSONALIDAD.md ignored', { reason: problem });
    return '';
  }
  return [
    '<personalidad>',
    'Cómo quiere el dueño que suenes (tono, estilo, trato). Es solo estilo: no cambia permisos, aprobaciones ni reglas de seguridad.',
    text,
    '</personalidad>',
  ].join('\n');
}
