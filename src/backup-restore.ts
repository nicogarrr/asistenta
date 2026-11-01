import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stateEntry } from './state-files.js';

/**
 * Restaurar una copia de `runBackup` (`<copias>/<AAAA-MM-DD>/`) sobre el estado.
 *
 * Antes era un «procedimiento documentado» a mano. Dos trampas que esto evita:
 * - Lo que se sustituye no se borra: se mueve a `<copias>/antes-de-restaurar-<marca>/`,
 *   así una restauración equivocada se deshace.
 * - Una base SQLite restaurada junto a un `-wal`/`-shm` viejo mezcla páginas de dos
 *   momentos (o se corrompe): esos ficheros se apartan también.
 * Con el daemon en marcha no se debe llamar (lo comprueba el comando).
 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function listBackups(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => DAY_RE.test(name) && statSync(join(root, name)).isDirectory())
    .sort()
    .reverse();
}

/**
 * Lo que una copia puede devolver al estado: lo que el registro (state-files.ts) dice
 * que va en la copia, o un *.json / *.db / *.sqlite suelto de la raíz que el registro no
 * nombra (backup.ts los copia por patrón). Lo excluido a propósito (vault.enc,
 * agent.pid, browser/, control/…) o desconocido no se restaura aunque esté en la copia.
 */
export function restorable(name: string): boolean {
  const entry = stateEntry(name);
  if (entry) return entry.backup !== false;
  return /\.(json|db|sqlite)$/.test(name);
}

/** Por qué falló la copia de `name`, dicho para el dueño (no el error crudo de Node). */
function restoreFailure(err: unknown, name: string): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EBUSY') return `${name} está abierto por otro programa`;
  if (code === 'EPERM' || code === 'EACCES') return `no tengo permiso para escribir ${name}`;
  if (code === 'ENOSPC') return 'no queda espacio en el disco';
  return `falló al copiar ${name}`;
}

export interface RestoreResult {
  from: string;
  restored: string[];
  /** Lo que estaba en la copia pero no se restaura (ver `restorable`). */
  skipped: string[];
  /** Donde quedó lo que había antes (vacío si no había nada que apartar). */
  savedDir: string;
}

export function restoreBackup(opts: {
  stateDir: string;
  /** Fecha AAAA-MM-DD; `ultima` (o vacío) = la más reciente. */
  date?: string;
  destDir?: string;
  now?: Date;
  /** Copia un fichero o carpeta de la copia al estado (los tests simulan fallos). */
  copy?: (from: string, to: string) => void;
}): RestoreResult {
  const root = opts.destDir ?? join(opts.stateDir, 'backups');
  const available = listBackups(root);
  const wanted = !opts.date || opts.date === 'ultima' ? available[0] : opts.date;
  if (!wanted || !DAY_RE.test(wanted) || !available.includes(wanted)) {
    if (!available.length) throw new Error('todavía no hay ninguna copia');
    throw new Error(
      `no hay copia de ${opts.date || 'ninguna fecha'}; copias disponibles: ${available.join(', ')}`,
    );
  }
  const from = join(root, wanted);
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const savedDir = join(root, `antes-de-restaurar-${stamp}`);
  const restored: string[] = [];
  const skipped: string[] = [];
  const copy = opts.copy ?? ((a: string, b: string) => cpSync(a, b, { recursive: true }));
  const setAsideDone: string[] = [];
  const setAside = (name: string): void => {
    const target = join(opts.stateDir, name);
    if (!existsSync(target)) return;
    mkdirSync(savedDir, { recursive: true });
    renameSync(target, join(savedDir, name));
    setAsideDone.push(name);
  };
  let current = '';
  try {
    for (const name of readdirSync(from)) {
      if (name === 'backups') continue;
      if (!restorable(name)) {
        skipped.push(name);
        continue;
      }
      current = name;
      setAside(name);
      if (/\.(db|sqlite)$/.test(name)) {
        setAside(`${name}-wal`);
        setAside(`${name}-shm`);
      }
      restored.push(name);
      copy(join(from, name), join(opts.stateDir, name));
    }
  } catch (err) {
    // A medias, el estado quedaba mezclado: se deshace todo antes de avisar.
    for (const name of restored)
      rmSync(join(opts.stateDir, name), { recursive: true, force: true });
    for (const name of setAsideDone) renameSync(join(savedDir, name), join(opts.stateDir, name));
    if (existsSync(savedDir)) rmSync(savedDir, { recursive: true, force: true });
    throw new Error(
      `No he podido restaurar la copia del ${wanted}: ${restoreFailure(err, current)}. No he cambiado nada.`,
    );
  }
  return { from, restored, skipped, savedDir: existsSync(savedDir) ? savedDir : '' };
}

/** `pa backup` (lista) y `pa backup restaurar <AAAA-MM-DD|ultima>`. */
export async function backupCommand(args: string[]): Promise<number> {
  const { paths } = await import('./paths.js');
  const root = join(paths.state, 'backups');
  const [sub, date] = args;
  if (!sub || sub === 'lista' || sub === 'list') {
    const list = listBackups(root);
    process.stdout.write(
      list.length
        ? `Copias (más reciente primero):\n${list.join('\n')}\n`
        : 'No hay copias todavía.\n',
    );
    return 0;
  }
  if (sub !== 'restaurar' && sub !== 'restore') {
    process.stderr.write('uso: pa backup [lista] | pa backup restaurar <AAAA-MM-DD|ultima>\n');
    return 2;
  }
  if (!date) {
    // Sin fecha no se restaura nada a ciegas: se pide y se enseñan las copias que hay.
    const list = listBackups(root);
    process.stderr.write(
      'uso: pa backup restaurar <AAAA-MM-DD|ultima>\n' +
        (list.length
          ? `Copias (más reciente primero): ${list.join(', ')}\n`
          : 'No hay copias todavía.\n'),
    );
    return 2;
  }
  try {
    const { assertNotRunning } = await import('./lifecycle.js');
    assertNotRunning(paths.state, 'agent');
  } catch {
    process.stderr.write('Asistenta está en marcha. Párala con «pa stop» y vuelve a probar.\n');
    return 1;
  }
  try {
    const r = restoreBackup({ stateDir: paths.state, date });
    process.stdout.write(
      `Restaurada la copia ${r.from}: ${r.restored.join(', ')}.\n` +
        (r.skipped.length ? `No restaurado (no va en la copia): ${r.skipped.join(', ')}.\n` : '') +
        (r.savedDir ? `Lo que había antes está en ${r.savedDir}.\n` : ''),
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}
