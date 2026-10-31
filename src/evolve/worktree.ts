import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  watch,
} from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';

/**
 * Isolating an attempt, so measuring it cannot disturb what is running.
 *
 * The loop edits the agent's own source. If it did that in place, a failed experiment
 * would leave the daemon running code that was measured and rejected, and the "before"
 * measurement would no longer be reproducible. Git worktrees solve both at once: each
 * attempt gets its own directory at its own commit, sharing the object store, so
 * isolation costs no disk and the kernel is never on the hook.
 *
 * Worktrees rather than Docker, because Docker cannot hold the Windows desktop the
 * computer-use tools drive, and every interesting measurement here involves a real
 * browser, a real screen and a real user profile. An environment that cannot see the
 * desktop would measure a different program than the one that ships.
 */

export interface Sandbox {
  dir: string;
  branch: string;
  /** Left on purpose when the attempt was promoted, so the diff is inspectable. */
  kept: boolean;
}

/** Rutas tal cual (sin comillas ni escapes octales) y sin detección de renombrados. */
const PLAIN_PATHS = ['-c', 'core.quotePath=false', '-c', 'diff.renames=false'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    // Listing ignored files of a sandbox that carries a copy of node_modules is far over the 1 MB default (ENOBUFS).
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

/** Repo root, from this file's own location: src/evolve/ -> ../.. */
export function repoRoot(): string {
  return join(process.cwd());
}

/**
 * A throwaway checkout at `base`, on its own branch.
 *
 * Throws if the branch already exists, because reusing one would mean measuring on top of
 * a previous candidate's leftovers, which is how a measurement quietly stops being a
 * measurement.
 */
export function createSandbox(root: string, base: string, id: number, dir: string): Sandbox {
  mkdirSync(dir, { recursive: true });
  const branch = `evolve/${id}`;
  const existing = git(root, ['branch', '--list', branch]);
  if (existing.trim()) {
    throw new Error(`la rama ${branch} ya existe: no se reutiliza un intento anterior`);
  }
  git(root, ['worktree', 'add', '-b', branch, dir, base]);
  // The sandbox has the sources but not the installed packages. It gets its OWN copy of the
  // kernel's node_modules: a link would let a candidate write into the kernel's real
  // dependencies, and commitAll leaves node_modules out of the diff on purpose, so the guard
  // would never see it. A copy costs disk and time once a week and removes that hole.
  const modules = join(root, 'node_modules');
  if (existsSync(modules) && !existsSync(join(dir, 'node_modules'))) {
    cpSync(modules, join(dir, 'node_modules'), {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: false,
    });
  }
  return { dir, branch, kept: false };
}

/** Throw the sandbox away. Called after every attempt that did not reach the kernel. */
export function dropSandbox(root: string, sandbox: Sandbox): void {
  try {
    git(root, ['worktree', 'remove', '--force', sandbox.dir]);
    git(root, ['branch', '-D', sandbox.branch]);
  } catch (err) {
    // A sandbox that cannot be removed must not stop the loop: the next week creates its
    // own. Say so, because a silently growing pile of worktrees is a disk problem later.
    process.stderr.write(`no se pudo limpiar el worktree ${sandbox.dir}: ${String(err)}\n`);
    return;
  }
  try {
    rmSync(sandbox.dir, { recursive: true, force: true });
  } catch {
    // git already removed the directory; nothing left to do.
  }
}

/** Files an attempt changed, relative to the repo root. Used to refuse forbidden edits. */
export function changedFiles(root: string, base: string, branch: string): string[] {
  // Sin -z git entrecomilla las rutas con tildes ("\"…\\303\\261…\""), y una ruta protegida así
  // (.github/workflows/ñ.yml) no casaba. Con renombrados detectados solo salía el nombre nuevo.
  const out = git(root, [...PLAIN_PATHS, 'diff', '--name-only', '-z', `${base}...${branch}`]);
  return out.split('\0').filter(Boolean);
}

/** Whether the tree is clean enough to start from. A dirty kernel is not a baseline. */
export function isClean(root: string): boolean {
  return git(root, ['status', '--porcelain']).trim() === '';
}

export function headCommit(root: string): string {
  return git(root, ['rev-parse', 'HEAD']);
}

/**
 * Commit whatever the proposer left in the sandbox, so what is checked and what is measured
 * are the same thing. Without this the forbidden-file check looks at commits while the
 * candidate is measured with the uncommitted working tree, and the guard sees nothing.
 */
export function commitAll(dir: string, message: string): void {
  // node_modules is the shared link from createSandbox, never part of the attempt.
  git(dir, ['add', '-A']);
  try {
    git(dir, ['reset', '-q', '--', 'node_modules']);
  } catch {
    // nothing of node_modules was staged
  }
  if (git(dir, ['diff', '--cached', '--name-only']).trim() === '') return;
  git(dir, [
    '-c',
    'user.name=asistenta-evolve',
    '-c',
    'user.email=evolve@localhost',
    'commit',
    '-q',
    '-m',
    message,
  ]);
}

/** The full unified diff of an attempt, for the guard's content rules and for the PR. */
export function diffText(root: string, base: string, branch: string): string {
  // Un test renombrado fuera de test/ debe verse como borrado (deleted file), no como «rename».
  return execFileSync('git', [...PLAIN_PATHS, 'diff', '--no-renames', `${base}...${branch}`], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Files in the sandbox that git ignores (other than node_modules). `git add -A` skips them, so
 * they would be measured but never checked: a candidate could hide a file there.
 */
export function ignoredFiles(dir: string): string[] {
  const out = git(dir, ['ls-files', '--others', '--ignored', '--exclude-standard']);
  return out
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f && !f.startsWith('node_modules/'));
}

/**
 * Huella del node_modules propio del sandbox: ruta, tamaño, fechas e inodo de cada entrada.
 * commitAll y ignoredFiles dejan node_modules fuera a propósito, así que un intento que
 * cambiara ahí una dependencia (por ejemplo el propio vitest) se mediría con ella sin que el
 * guard lo viera (salvo la caché de vitest). ctime cambia con cualquier escritura o utimes, así que no se disimula.
 */
export function depsFingerprint(dir: string): string {
  const base = join(dir, 'node_modules');
  if (!existsSync(base)) return '';
  const h = createHash('sha256');
  const walk = (rel: string): void => {
    const names = readdirSync(join(base, rel)).sort();
    for (const n of names) {
      // La caché de vitest (resultados para ordenar tests) cambia con solo pasar los tests.
      if (!rel && (n === '.vite' || n === '.vitest')) continue;
      const r = rel ? `${rel}/${n}` : n;
      const st = lstatSync(join(base, r));
      const link = st.isSymbolicLink() ? readlinkSync(join(base, r)) : '';
      h.update(`${r}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}\0${st.ino}\0${link}\n`);
      if (st.isDirectory()) walk(r);
    }
  };
  walk('');
  return h.digest('hex');
}

/**
 * Huella del git del intento, leída del disco sin llamar a git: el fichero `.git` del
 * worktree (a qué carpeta apunta) y, en esa carpeta privada, HEAD, commondir, gitdir y
 * config.worktree. Si el proponente apunta su HEAD a la rama del kernel o su `.git` a otro
 * repo, el commit del intento caería allí sin pasar por el guard.
 */
export function sandboxGitFingerprint(dir: string): string {
  const h = createHash('sha256');
  const gitFile = join(dir, '.git');
  if (!existsSync(gitFile) || !lstatSync(gitFile).isFile()) return 'no-gitfile';
  const text = readFileSync(gitFile, 'utf8');
  h.update(text);
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (m?.[1]) {
    const priv = isAbsolute(m[1]) ? m[1] : join(dir, m[1]);
    for (const rel of ['HEAD', 'commondir', 'gitdir', 'config.worktree']) {
      const p = join(priv, rel);
      h.update(`\0${rel}\0`);
      if (existsSync(p) && lstatSync(p).isFile()) h.update(readFileSync(p));
      else h.update('-');
    }
  }
  return h.digest('hex');
}

/**
 * Huella de lo que hace ejecutar código a git en el repo del kernel: su config (core.fsmonitor,
 * core.hooksPath, alias…) y la carpeta de hooks, compartidas por todos los worktrees. Se lee
 * del disco sin llamar a git, porque un fsmonitor plantado se ejecutaría con el propio
 * `git status` que lo comprueba.
 */
export function gitControlFingerprint(root: string): string {
  let common = git(root, ['rev-parse', '--git-common-dir']);
  if (!isAbsolute(common)) common = join(root, common);
  const h = createHash('sha256');
  const add = (rel: string): void => {
    const p = join(common, rel);
    if (!existsSync(p)) {
      h.update(`${rel}\0-\n`);
      return;
    }
    if (statSync(p).isDirectory()) {
      for (const n of readdirSync(p).sort()) add(`${rel}/${n}`);
      return;
    }
    h.update(`${rel}\0`);
    h.update(readFileSync(p));
    h.update('\n');
  };
  for (const rel of ['config', 'config.worktree', 'hooks', 'info/attributes']) add(rel);
  return h.digest('hex');
}

/**
 * Huella del disco de los ficheros versionados: tamaño, fechas e inodo de cada uno. `git status`
 * compara contenido, así que un test cambiado durante la medición y devuelto a su texto después
 * pasa por limpio; su ctime no se puede devolver. Medir (la suite y la sonda) no toca la ctime
 * de ningún fichero versionado (comprobado en la suite completa, 31 oct).
 */
export function treeStatFingerprint(dir: string): string {
  const h = createHash('sha256');
  for (const f of git(dir, ['ls-files', '-z']).split('\0')) {
    if (!f) continue;
    let line: string;
    try {
      const st = lstatSync(join(dir, f));
      line = `${f}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}\0${st.ino}`;
    } catch {
      line = `${f}\0-`;
    }
    h.update(`${line}\n`);
  }
  return h.digest('hex');
}

/**
 * Huella de las carpetas con ficheros versionados (sin la raíz): fechas e inodo. Un fichero
 * nuevo creado antes de que vitest recoja los tests y borrado antes de la revisión final (un
 * test/x.test.ts que pasa) no deja rastro en git status ni en los ficheros versionados, pero
 * sí en la fecha de su carpeta. Medir no cambia ninguna de estas carpetas (suite completa y
 * sonda, 31 oct). La raíz sí cambia (un test crea y borra allí una carpeta temporal): la
 * vigila watchRoot.
 */
export function treeDirFingerprint(dir: string): string {
  const dirs = new Set<string>();
  for (const f of git(dir, ['ls-files', '-z']).split('\0')) {
    if (!f) continue;
    for (let d = posix.dirname(f); d !== '.' && !dirs.has(d); d = posix.dirname(d)) dirs.add(d);
  }
  const h = createHash('sha256');
  for (const d of [...dirs].sort()) {
    let line: string;
    try {
      const st = lstatSync(join(dir, d));
      line = `${d}\0${st.mtimeMs}\0${st.ctimeMs}\0${st.ino}`;
    } catch {
      line = `${d}\0-`;
    }
    h.update(`${line}\n`);
  }
  return h.digest('hex');
}

/** Lo único que una medición normal crea y borra en la raíz (test/context-limits.test.ts). */
const ROOT_TEMP = [/^\.tmp-read-cap-/];

/**
 * Vigila la raíz de la copia mientras se mide. Un vitest.workspace.ts o un .env creados al
 * empezar y borrados al acabar cambian qué se mide sin dejar huella en git. Devuelve una
 * función que para la vigilancia y dice qué nombres aparecieron o cambiaron (fuera de los
 * temporales conocidos); si no se pudo vigilar, lo dice también, porque no se sabe.
 */
export function watchRoot(dir: string): () => Promise<string[]> {
  const seen = new Set<string>();
  let failed = '';
  let w: ReturnType<typeof watch> | undefined;
  try {
    w = watch(dir, { persistent: false }, (_ev, name) => {
      if (name) seen.add(String(name));
      else failed = '(cambio sin nombre)';
    });
    w.on('error', () => {
      failed = '(no se pudo vigilar la raíz)';
    });
  } catch {
    failed = '(no se pudo vigilar la raíz)';
  }
  return async () => {
    // Los avisos del sistema llegan en la siguiente vuelta del bucle de eventos.
    await new Promise((r) => setTimeout(r, 200));
    w?.close();
    const bad = [...seen].filter((n) => !ROOT_TEMP.some((re) => re.test(n))).sort();
    return failed ? [...bad, failed] : bad;
  };
}
