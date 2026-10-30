import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';

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
let lastDir: string | undefined;

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** Misma frontera que la herramienta write: nada fuera del directorio de trabajo. */
function insideCwd(path: string): boolean {
  const rel = relative(process.cwd(), path);
  return !(rel.startsWith('..') || isAbsolute(rel));
}

export function setUndoDir(dir: string | undefined): void {
  undoDir = dir;
}

interface Meta {
  path: string;
  existed: boolean;
  at: string;
  tooBig?: boolean;
  /** Hash de lo que escribió `write`: si el fichero ya no coincide, alguien lo tocó después. */
  writtenSha?: string;
}

/** Llamar justo antes de escribir. Nunca lanza: deshacer no puede romper una escritura. */
export function recordBeforeWrite(path: string, now: Date = new Date()): string | undefined {
  if (!undoDir) return undefined;
  try {
    const existed = existsSync(path) && statSync(path).isFile();
    const tooBig = existed && statSync(path).size > MAX_FILE_BYTES;
    const id = `${String(now.getTime()).padStart(13, '0')}-${String(seq++ % 1000).padStart(3, '0')}`;
    const dir = join(undoDir, id);
    lastDir = dir;
    mkdirSync(dir, { recursive: true });
    const meta: Meta = { path, existed, at: now.toISOString(), ...(tooBig ? { tooBig } : {}) };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta), 'utf8');
    if (existed && !tooBig) writeFileSync(join(dir, 'content'), readFileSync(path));
    const all = readdirSync(undoDir).sort();
    for (const old of all.slice(0, Math.max(0, all.length - MAX_ENTRIES))) {
      rmSync(join(undoDir, old), { recursive: true, force: true });
    }
    return dir;
  } catch {
    // Mejor una escritura sin copia que una escritura que falla por la copia.
    return undefined;
  }
}

/**
 * Llamar justo después de escribir: anota el hash de lo escrito para detectar
 * cambios posteriores. `entry` es lo que devolvió `recordBeforeWrite` para ESTA
 * escritura: con dos escrituras solapadas (otra herramienta, otro hilo) el
 * global `lastDir` apunta a la última copia y el hash acababa en la entrada
 * equivocada, dejando la primera escritura sin poder deshacerse.
 */
export function recordAfterWrite(content: string, entry: string | undefined = lastDir): void {
  if (!undoDir || !entry) return;
  try {
    const f = join(entry, 'meta.json');
    const meta = JSON.parse(readFileSync(f, 'utf8')) as Meta;
    meta.writtenSha = sha(content);
    writeFileSync(f, JSON.stringify(meta), 'utf8');
  } catch {
    // Sin hash, /deshacer se niega a tocar el fichero (ver undoLast).
  }
}

/**
 * Una entrada sin `writtenSha` cuyo fichero sigue exactamente como estaba antes es
 * una escritura que nunca llegó a hacerse (la herramienta `write` lanzó entre
 * `recordBeforeWrite` y `recordAfterWrite`: EISDIR, EACCES, disco lleno...). No hay
 * nada que deshacer en ella, y dejarla arriba bloqueaba /deshacer para siempre.
 */
function neverLanded(meta: Meta, dir: string): boolean {
  if (meta.writtenSha !== undefined || meta.tooBig) return false;
  try {
    const isFile = existsSync(meta.path) && statSync(meta.path).isFile();
    if (!meta.existed) return !existsSync(meta.path);
    if (!isFile) return false;
    return sha(readFileSync(meta.path)) === sha(readFileSync(join(dir, 'content')));
  } catch {
    return false;
  }
}

/** Repone la última escritura guardada. Devuelve el texto para el usuario. */
export function undoLast(): string {
  if (!undoDir || !existsSync(undoDir)) return 'No tengo ninguna escritura que deshacer.';
  const all = readdirSync(undoDir).sort();
  let dir = '';
  let meta: Meta | undefined;
  for (let i = all.length - 1; i >= 0; i--) {
    dir = join(undoDir, all[i] as string);
    try {
      meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Meta;
    } catch {
      rmSync(dir, { recursive: true, force: true });
      return 'La última copia estaba dañada y la he descartado. Prueba otra vez.';
    }
    if (!neverLanded(meta, dir)) break;
    rmSync(dir, { recursive: true, force: true });
    meta = undefined;
  }
  if (!meta) return 'No tengo ninguna escritura que deshacer.';
  if (!insideCwd(meta.path)) {
    return `No toco ${meta.path}: queda fuera del directorio de trabajo.`;
  }
  // Si el fichero ya no es lo que escribió `write`, reponerlo pisaría trabajo posterior.
  const now =
    existsSync(meta.path) && statSync(meta.path).isFile() ? readFileSync(meta.path) : null;
  const expected = meta.writtenSha;
  const changed = expected === undefined ? true : now !== null && sha(now) !== expected;
  if (changed) {
    return `No toco ${meta.path}: ha cambiado desde mi última escritura y deshacer pisaría ese cambio. Revísalo tú o dime qué hacer.`;
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
  if (now !== null) rmSync(meta.path, { force: true });
  rmSync(dir, { recursive: true, force: true });
  return `Ese fichero no existía antes: he borrado ${meta.path}, que se creó en la última escritura (${meta.at.slice(0, 16).replace('T', ' ')} UTC).`;
}
