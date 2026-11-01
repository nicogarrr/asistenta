/** Wizard-only pure ownership: no PID probe, cleanup, socket, READY or stopped proof. */
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  type Stats,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

function linux(): void {
  if (process.platform !== 'linux')
    throw new Error(
      'La configuración automática solo funciona en Linux; en Windows sigue la guía (instalar.bat).',
    );
}
function optionalStat(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('No puedo comprobar la carpeta de datos, así que no toco nada.');
  }
}
function privateOwner(stat: Stats, directory: boolean): void {
  if (
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  )
    throw new Error('La carpeta de datos tiene un dueño o unos permisos raros; no la toco.');
}
/** Read-only check. Unknown evidence is a refusal, never a stale-reclaim signal. */
export function inspectSetupOwnership(stateDir: string): void {
  linux();
  const state = resolve(stateDir);
  let ancestor: string = sep;
  for (const component of state.split(sep).filter(Boolean)) {
    ancestor = join(ancestor, component);
    if (optionalStat(ancestor)?.isSymbolicLink())
      throw new Error('La carpeta de datos es un acceso directo (enlace simbólico); no la toco.');
  }
  const stat = optionalStat(state);
  if (!stat) return;
  privateOwner(stat, true);
  for (const name of ['agent.pid', 'agent.pid.stale']) {
    if (optionalStat(join(state, name)))
      throw new Error(
        'Parece que Asistenta ya se ha ejecutado aquí antes. No toco nada: párala con «pa stop» y vuelve a probar.',
      );
  }
  const control = join(state, 'control');
  const controlStat = optionalStat(control);
  if (!controlStat) return;
  privateOwner(controlStat, true);
  for (const name of readdirSync(control)) {
    // Persistent lock and final proof names may remain after a clean close. Their
    // presence is not used as evidence of a clean exit or permission to reclaim.
    if (name !== 'owner.lock' && !/^[a-f0-9]{64}\.stopped$/.test(name))
      throw new Error(
        'Quedan restos de una ejecución anterior de Asistenta; no los toco ni los borro.',
      );
    const entry = optionalStat(join(control, name));
    if (!entry) throw new Error('La carpeta de datos cambió mientras la revisaba; paro aquí.');
    privateOwner(entry, false);
  }
}
export interface SetupOwnership {
  assert(): void;
  release(): void;
}
/** Acquire the same OS lock as daemon start, without invoking daemon reclamation. */
export function acquireSetupOwnership(stateDir: string): SetupOwnership {
  inspectSetupOwnership(stateDir);
  const state = resolve(stateDir);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const control = join(state, 'control');
  mkdirSync(control, { recursive: true, mode: 0o700 });
  inspectSetupOwnership(state);
  const file = join(control, 'owner.lock');
  const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let released = false;
  const initial = fstatSync(fd);
  const check = () => {
    if (released) throw new Error('La configuración ya había terminado; no puedo guardar.');
    const current = optionalStat(file);
    if (!current || current.ino !== initial.ino || current.dev !== initial.dev)
      throw new Error('Otra configuración se ha puesto en medio; no guardo nada.');
    privateOwner(current, false);
    inspectSetupOwnership(state);
  };
  try {
    privateOwner(initial, false);
    const result = spawnSync('flock', ['--exclusive', '--nonblock', '4'], {
      stdio: ['ignore', 'ignore', 'ignore', 'ignore', fd],
      timeout: 3000,
    });
    if (result.error || result.status !== 0)
      throw new Error('Asistenta u otra configuración ya está en marcha; no cambio nada.');
    check();
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return {
    assert: check,
    release() {
      if (released) return;
      released = true;
      closeSync(fd);
    },
  };
}
