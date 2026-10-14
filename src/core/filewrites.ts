/**
 * Real file-write accounting for one agent run.
 *
 * The audit metric "builds multi-archivo" (ROADMAP.md, multi-agent trigger)
 * has to measure outcome, not attempts: two writes to the SAME file are one
 * file, and a write that failed (tool error or gate refusal) wrote nothing.
 * `onToolCall` fires at tool_execution_start with no path and no success
 * signal, so counting calls there invents builds that never happened
 * (auditor, #134).
 *
 * This tracker captures the normalized path at tool_execution_start and only
 * commits it on tool_execution_end without error. It exposes ONLY the count:
 * paths never leave the run, because audit lines, hooks and logs are public
 * surfaces and a path can carry a user folder or a secret-looking name.
 */

import { normalize } from 'node:path';

/** Canonical enough to dedupe retries: trim + platform normalize ("./a.txt" ≡ "a.txt"). */
export function normalizeWritePath(raw: string): string {
  return normalize(raw.trim());
}

export class FileWriteTracker {
  /** In-flight write calls, toolCallId -> normalized path. */
  readonly #pending = new Map<string, string>();
  /** Normalized paths confirmed written (tool_execution_end without error). */
  readonly #written = new Set<string>();

  /** tool_execution_start: remember the path only for the fs write tool. */
  start(toolCallId: string, tool: string, args: unknown): void {
    if (tool !== 'write') return;
    const path = (args as { path?: unknown } | null | undefined)?.path;
    if (typeof path !== 'string' || !path.trim()) return;
    this.#pending.set(toolCallId, normalizeWritePath(path));
  }

  /** tool_execution_end: commit on success, drop on error. Unknown ids are ignored. */
  end(toolCallId: string, isError: boolean): void {
    const path = this.#pending.get(toolCallId);
    if (path === undefined) return;
    this.#pending.delete(toolCallId);
    if (!isError) this.#written.add(path);
  }

  /** Distinct files actually written OK in this run. */
  get count(): number {
    return this.#written.size;
  }
}
