import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Deshacer: antes de que la herramienta `write` toque un fichero, guarda cómo estaba.
 *
 * "Borró mi código y no había vuelta atrás" es el miedo de cualquier agente con acceso
 * a ficheros, y `write` sobrescribe sin avisar. Aquí se guarda el contenido anterior
 * (o que el fichero no existía) en state/undo, y `/deshacer` repone la última
 * escritura. Solo cubre `write`: lo que se haga por la shell no pasa por aquí, y el
 * mensaje de /deshacer lo dice para no prometer más de lo que hace.
 *
 * Sin directorio configurado no guarda nada, así los tests y `run` suelto no escriben
 * en el estado real de nadie.
 */

const MAX_ENTRIES = 30;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

let undoDir: string | undefined;
let seq = 0;

export function setUndoDir(dir: string | undefined): void {
  undoDir = dir;
}

interface Meta {
  path: string;
  existed: boolean;
  at: string;
  tooBig?: boolean;
}

/** Llamar justo antes de escribir. Nunca lanza: deshacer no puede romper una escritura. */
export function recordBeforeWrite(path: string, now: Date = new Date()): void {
  if (!undoDir) return;
  try {
    const existed = existsSync(path) && statSync(path).isFile();
    const tooBig = existed && statSync(path).size > MAX_FILE_BYTES;
    const id = `${String(now.getTime()).padStart(13, '0')}-${String(seq++ % 1000).padStart(3, '0')}`;
    const dir = join(undoDir, id);
    mkdirSync(dir, { recursive: true });
    const meta: Meta = { path, existed, at: now.toISOString(), ...(tooBig ? { tooBig } : {}) };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta), 'utf8');
    if (existed && !tooBig) writeFileSync(join(dir, 'content'), readFileSync(path));
    const all = readdirSync(undoDir).sort();
    for (const old of all.slice(0, Math.max(0, all.length - MAX_ENTRIES))) {
      rmSync(join(undoDir, old), { recursive: true, force: true });
    }
  } catch {
    // Mejor una escritura sin copia que una escritura que falla por la copia.
  }
}

/** Repone la última escritura guardada. Devuelve el texto para el usuario. */
export function undoLast(): string {
  if (!undoDir || !existsSync(undoDir)) return 'No tengo ninguna escritura que deshacer.';
  const all = readdirSync(undoDir).sort();
  const id = all[all.length - 1];
  if (!id) return 'No tengo ninguna escritura que deshacer.';
  const dir = join(undoDir, id);
  let meta: Meta;
  try {
    meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Meta;
  } catch {
    rmSync(dir, { recursive: true, force: true });
    return 'La última copia estaba dañada y la he descartado. Prueba otra vez.';
  }
  if (meta.tooBig) {
    rmSync(dir, { recursive: true, force: true });
    return `No pude guardar la versión anterior de ${meta.path} (más de 5 MB), así que no puedo reponerla.`;
  }
  if (meta.existed) {
    mkdirSync(dirname(meta.path), { recursive: true });
    writeFileSync(meta.path, readFileSync(join(dir, 'content')));
    rmSync(dir, { recursive: true, force: true });
    return `He repuesto ${meta.path} a como estaba antes de la última escritura (${meta.at.slice(0, 16).replace('T', ' ')} UTC). Solo deshago lo que se escribió con la herramienta de ficheros; lo hecho por la shell no.`;
  }
  rmSync(meta.path, { force: true });
  rmSync(dir, { recursive: true, force: true });
  return `Ese fichero no existía antes: he borrado ${meta.path}, que se creó en la última escritura (${meta.at.slice(0, 16).replace('T', ' ')} UTC).`;
}
