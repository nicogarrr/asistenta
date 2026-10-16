/**
 * Real file-write accounting for one agent run (shared across retries: the
 * tracker lives in AttemptState, so a transient-provider retry keeps the
 * writes the earlier attempt already did — auditor #134 ronda 3).
 *
 * The audit metric "builds multi-archivo" (ROADMAP.md, multi-agent trigger)
 * has to measure outcome, not attempts: two writes to the SAME destination
 * are one, and a write that failed (tool error or gate refusal) wrote
 * nothing. This tracker captures the resolved path at tool_execution_start
 * and only commits it on tool_execution_end without error. It exposes ONLY
 * the count: paths never leave the run, because audit lines, hooks and logs
 * are public surfaces and a path can carry a user folder or a secret-looking
 * name.
 */

import * as os from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * Canonical enough to dedupe the same destination: resolved against the fs
 * write tool's working directory (the tool resolves with `path.resolve`
 * against `process.cwd()`, so a relative and an absolute spelling of the same
 * file collide) and lower-cased on Windows, where the filesystem is
 * case-insensitive ("A.ts" ≡ "a.ts"). NO trim: leading/trailing spaces are
 * valid filename characters and trimming would merge two different files.
 *
 * Declared scope: this dedupes PATHS, not FILES — symlinks and hard links to
 * the same file still count as two destinations.
 */
export function normalizeWritePath(
  raw: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  homedir: string = os.homedir(),
): string {
  // The fs tool expands a leading ~ to the homedir BEFORE resolving (same
  // regex, same order), so `~/a` and its absolute spelling are one
  // destination; homedir is injectable for tests.
  const expanded = raw.replace(/^~(?=$|[\\/])/, homedir);
  if (platform === 'win32') return win32.resolve(cwd, expanded).toLowerCase();
  return posix.resolve(cwd, expanded);
}

export class FileWriteTracker {
  readonly #cwd: string;
  readonly #platform: NodeJS.Platform;
  readonly #homedir: string;
  /** In-flight write calls, toolCallId -> resolved path. */
  readonly #pending = new Map<string, string>();
  /** Resolved paths confirmed written (tool_execution_end without error). */
  readonly #written = new Set<string>();

  /** cwd/platform/homedir injectables para tests; por defecto los del proceso, que son los del fs tool. */
  constructor(opts?: { cwd?: string; platform?: NodeJS.Platform; homedir?: string }) {
    this.#cwd = opts?.cwd ?? process.cwd();
    this.#platform = opts?.platform ?? process.platform;
    this.#homedir = opts?.homedir ?? os.homedir();
  }

  /** tool_execution_start: remember the path only for the fs write tool. */
  start(toolCallId: string, tool: string, args: unknown): void {
    if (tool !== 'write') return;
    const path = (args as { path?: unknown } | null | undefined)?.path;
    if (typeof path !== 'string' || path === '') return;
    this.#pending.set(
      toolCallId,
      normalizeWritePath(path, this.#cwd, this.#platform, this.#homedir),
    );
  }

  /** tool_execution_end: commit on success, drop on error. Unknown ids are ignored. */
  end(toolCallId: string, isError: boolean): void {
    const path = this.#pending.get(toolCallId);
    if (path === undefined) return;
    this.#pending.delete(toolCallId);
    if (!isError) this.#written.add(path);
  }

  /** Distinct destinations actually written OK in this run (all attempts). */
  get count(): number {
    return this.#written.size;
  }
}
