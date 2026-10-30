import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

export interface RestoreResult {
  from: string;
  restored: string[];
  /** Donde quedó lo que había antes (vacío si no había nada que apartar). */
  savedDir: string;
}

export function restoreBackup(opts: {
  stateDir: string;
  /** Fecha AAAA-MM-DD; `ultima` (o vacío) = la más reciente. */
  date?: string;
  destDir?: string;
  now?: Date;
}): RestoreResult {
  const root = opts.destDir ?? join(opts.stateDir, 'backups');
  const available = listBackups(root);
  const wanted = !opts.date || opts.date === 'ultima' ? available[0] : opts.date;
  if (!wanted || !DAY_RE.test(wanted) || !available.includes(wanted)) {
    const list = available.length ? available.join(', ') : 'ninguna';
    throw new Error(`no hay copia de ${opts.date || 'ninguna fecha'}; copias disponibles: ${list}`);
  }
  const from = join(root, wanted);
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const savedDir = join(root, `antes-de-restaurar-${stamp}`);
  const restored: string[] = [];
  const setAside = (name: string): void => {
    const target = join(opts.stateDir, name);
    if (!existsSync(target)) return;
    mkdirSync(savedDir, { recursive: true });
    renameSync(target, join(savedDir, name));
  };
  for (const name of readdirSync(from)) {
    if (name === 'backups') continue;
    setAside(name);
    if (/\.(db|sqlite)$/.test(name)) {
      setAside(`${name}-wal`);
      setAside(`${name}-shm`);
    }
    cpSync(join(from, name), join(opts.stateDir, name), { recursive: true });
    restored.push(name);
  }
  return { from, restored, savedDir: existsSync(savedDir) ? savedDir : '' };
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
  try {
    const { assertNotRunning } = await import('./lifecycle.js');
    assertNotRunning(paths.state, 'agent');
  } catch {
    process.stderr.write(
      'Asistenta está en marcha: para el daemon (pa stop) antes de restaurar.\n',
    );
    return 1;
  }
  try {
    const r = restoreBackup({ stateDir: paths.state, date });
    process.stdout.write(
      `Restaurada la copia ${r.from}: ${r.restored.join(', ')}.\n` +
        (r.savedDir ? `Lo que había antes está en ${r.savedDir}.\n` : ''),
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}
