import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
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
  // The sandbox has the sources but not the installed packages. The candidate cannot change
  // package.json (forbidden), so sharing the kernel's node_modules is the same dependency set,
  // and it is what lets vitest and tsx run at all in a fresh checkout.
  const modules = join(root, 'node_modules');
  if (existsSync(modules) && !existsSync(join(dir, 'node_modules'))) {
    symlinkSync(modules, join(dir, 'node_modules'), 'junction');
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
  const out = git(root, ['diff', '--name-only', `${base}...${branch}`]);
  return out
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean);
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
  return execFileSync('git', ['diff', `${base}...${branch}`], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
}
