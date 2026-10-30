import { randomBytes } from 'node:crypto';

/**
 * Ruta temporal única para «escribir en tmp + rename». Un `${path}.tmp` fijo lo
 * comparten el daemon y la CLI (`pa …`): si los dos escriben a la vez, uno renombra
 * el tmp a medio escribir del otro, o falla con ENOENT al renombrar. Con pid +
 * aleatorio cada escritor tiene el suyo y el rename sigue siendo atómico.
 */
export function uniqueTmpPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}
