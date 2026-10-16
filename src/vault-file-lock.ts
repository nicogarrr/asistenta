/** Linux cooperating-writer exclusion, keyed by the actual portable secrets file. */
import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

function noSymlinks(path: string): void {
  let part: string = sep;
  for (const component of resolve(path).split(sep).filter(Boolean)) {
    part = resolve(part, component);
    try {
      if (lstatSync(part).isSymbolicLink())
        throw new Error('La ruta del almacén no puede contener enlaces simbólicos.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
function privateDirectory(dir: string): void {
  noSymlinks(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new Error('El directorio del almacén debe ser privado y pertenecer al usuario actual.');
}
function safeFile(file: string, allowMissing = false): void {
  try {
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error('Archivo del almacén con tipo, propietario o permisos no seguros.');
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
export async function withPortableVaultLock<T>(
  file: string,
  operation: () => Promise<T>,
): Promise<T> {
  // Existing Windows portable/DPAPI behavior is not expanded. No Windows mutex claim.
  if (process.platform !== 'linux') return operation();
  const canonical = resolve(file);
  noSymlinks(canonical);
  privateDirectory(dirname(canonical));
  safeFile(canonical, true);
  const lock = `${canonical}.writer.lock`;
  const fd = openSync(lock, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    safeFile(lock);
    const owner = fstatSync(fd);
    await new Promise<void>((yes, no) => {
      const child = spawn('flock', ['--exclusive', '--timeout', '5', '4'], {
        stdio: ['ignore', 'ignore', 'ignore', 'ignore', fd],
      });
      child.once('error', () =>
        no(new Error('No se pudo adquirir exclusión del almacén; requiere flock en Linux.')),
      );
      child.once('exit', (code) =>
        code === 0
          ? yes()
          : no(
              new Error(
                'Otro escritor mantiene el almacén ocupado; no se ha guardado ningún cambio.',
              ),
            ),
      );
    });
    // No path supplied by metadata. Never unlink a live lock; kernel releases on crash.
    noSymlinks(canonical);
    safeFile(lock);
    const current = lstatSync(lock);
    if (current.ino !== owner.ino || current.dev !== owner.dev)
      throw new Error('La propiedad del almacén cambió; no se guarda.');
    safeFile(canonical, true);
    return await operation();
  } finally {
    closeSync(fd);
  }
}
