import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Ruta temporal única para «escribir en tmp + rename». Un `${path}.tmp` fijo lo
 * comparten el daemon y la CLI (`pa …`): si los dos escriben a la vez, uno renombra
 * el tmp a medio escribir del otro, o falla con ENOENT al renombrar. Con pid +
 * aleatorio cada escritor tiene el suyo y el rename sigue siendo atómico.
 */
export function uniqueTmpPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

/**
 * Aparta un fichero de estado ilegible a `<fichero>.corrupt-<fecha>-<rand>` antes
 * de escribir encima. Los almacenes que leen un JSON corrupto como «vacío» para
 * seguir funcionando perderían todo su contenido en la siguiente escritura; así
 * queda una copia recuperable. Devuelve la ruta de la copia. Si no se puede
 * apartar lanza: mejor no escribir que borrar los datos.
 */
export function setAsideCorrupt(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${path}.corrupt-${stamp}-${randomBytes(2).toString('hex')}`;
  try {
    renameSync(path, backup);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return backup;
    throw new Error(
      `${path} está corrupto y no se pudo apartar; no se sobrescribe (${String(err)})`,
    );
  }
  return backup;
}

/**
 * Escribe `path` vía tmp único + rename. Si algo falla (en Windows el rename falla si
 * otro programa tiene el destino abierto), borra el tmp antes de relanzar el error:
 * sin esto, cada intento fallido deja otro `.tmp` en la carpeta de estado.
 */
export function writeFileReplacing(path: string, data: string): void {
  const tmp = uniqueTmpPath(path);
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Ni el tmp se puede quitar: no hay nada más que hacer.
    }
    throw error;
  }
}
