/**
 * Append-only record of what the agent did, and to what.
 *
 * The daemon transcript says what was said; this says what was *done*. The two
 * are separate files because the questions differ: "show me every file the agent
 * deleted last week" must not require replaying a conversation, and a tool that
 * ran but failed to answer is still an action worth recording.
 *
 * JSONL rather than a database on purpose: a line is written in one syscall, a
 * crash mid-write can lose the last line but can never corrupt an earlier one,
 * and `tail -f` on a chat is a feature. Rotation is one generation deep (`.1`),
 * because the point of the log is "what happened recently", not an audit trail
 * for compliance.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { wallHourMinute } from '../datecontext.js';
import { log, redact, scrubLogText } from '../log.js';
import { sliceSafe } from '../text.js';

export type ActionResult = 'ok' | 'error' | 'blocked';

/** One line of the log, as it is stored. `ts` is stamped by `record`, not by the caller. */
export interface ActionEntry {
  ts: string;
  actor: string;
  action: string;
  target?: string;
  result: ActionResult;
  detail?: string;
}

export interface ActionRecord {
  actor: string;
  action: string;
  target?: string;
  result: ActionResult;
  detail?: string;
}

export interface ActionFilter {
  action?: string;
  result?: string;
}

/** 5 MB. Enough for days of activity, small enough to grep without thinking. */
const MAX_BYTES = 5 * 1024 * 1024;

function isResult(value: unknown): value is ActionResult {
  return value === 'ok' || value === 'error' || value === 'blocked';
}

/** Tolerant of anything a truncated or hand-edited line may hold: junk is skipped, not thrown. */
function parseEntry(line: string): ActionEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ts !== 'string' || typeof r.actor !== 'string' || typeof r.action !== 'string') {
    return null;
  }
  if (!isResult(r.result)) return null;
  const entry: ActionEntry = { ts: r.ts, actor: r.actor, action: r.action, result: r.result };
  if (typeof r.target === 'string') entry.target = r.target;
  if (typeof r.detail === 'string') entry.detail = r.detail;
  return entry;
}

/** HH:MM on Nico's wall clock (PA_TIMEZONE): the summary is read by a person, not parsed. */
function hhmm(ts: string): string {
  return wallHourMinute(new Date(ts));
}

function clip(text: string, max = 60): string {
  return text.length > max ? `${sliceSafe(text, max - 1)}…` : text;
}

function formatEntry(e: ActionEntry): string {
  const parts = [`• ${hhmm(e.ts)} ${e.actor} ${e.action}`];
  // También al mostrar: las entradas escritas antes de tapar en record() siguen en disco.
  if (e.target) parts.push(`sobre ${clip(scrubLogText(e.target))}`);
  parts.push(`→ ${e.result}`);
  if (e.detail) parts.push(`(${clip(scrubLogText(e.detail))})`);
  return parts.join(' ');
}

export class ActionLog {
  readonly #file: string;

  constructor(opts: { file: string }) {
    this.#file = opts.file;
  }

  /**
   * Append one entry. Synchronous and never throwing: the callers are tool
   * handlers whose real job is the action itself, and a failed log write must
   * not fail the turn. The failure is still visible, in the daemon log.
   */
  record(entry: ActionRecord): void {
    const line: ActionEntry = {
      ts: new Date().toISOString(),
      actor: entry.actor,
      action: entry.action,
      result: entry.result,
    };
    // target/detail los rellenan las herramientas con texto libre (una URL con
    // ?token=…, una orden con password=…): se tapan antes de tocar el disco.
    if (entry.target !== undefined) line.target = scrubLogText(entry.target);
    if (entry.detail !== undefined) line.detail = scrubLogText(entry.detail);
    let serialized: string;
    try {
      serialized = `${JSON.stringify(line)}\n`;
    } catch (err) {
      log.warn('action log entry not serializable', { action: entry.action, ...redact({ err }) });
      return;
    }
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      this.#rotateIfNeeded();
      appendFileSync(this.#file, serialized);
    } catch (err) {
      log.warn('action log write failed', { file: this.#file, ...redact({ err }) });
    }
  }

  /** The newest `limit` entries, oldest first. Optionally narrowed to one action or result. */
  recent(limit = 50, filter?: ActionFilter): ActionEntry[] {
    const all = this.#readAll();
    const matched = all.filter(
      (e) =>
        (filter?.action === undefined || e.action === filter.action) &&
        (filter?.result === undefined || e.result === filter.result),
    );
    // `slice(-0)` is `slice(0)`: a limit of 0 used to return the whole log.
    if (!(limit > 0)) return [];
    return matched.slice(-Math.floor(limit));
  }

  /**
   * Digest for Telegram: how much happened, how much of it went wrong, and the
   * five latest entries. Spanish because it is pasted into a chat as-is.
   */
  summary(hours = 24): string {
    let entries: ActionEntry[];
    try {
      const cutoff = Date.now() - Math.max(0, hours) * 3_600_000;
      entries = this.#readAll().filter((e) => {
        const at = Date.parse(e.ts);
        return Number.isFinite(at) && at >= cutoff;
      });
    } catch (err) {
      log.warn('action log summary failed', { file: this.#file, ...redact({ err }) });
      return 'No pude leer el registro de acciones.';
    }
    const errors = entries.filter((e) => e.result === 'error').length;
    const blocked = entries.filter((e) => e.result === 'blocked').length;
    const head = `Acciones en las últimas ${hours} h: ${entries.length} (errores: ${errors}, bloqueadas: ${blocked}).`;
    const last = entries.slice(-5);
    if (last.length === 0) return `${head}\nSin acciones recientes.`;
    return `${head}\nÚltimas:\n${last.map(formatEntry).join('\n')}`;
  }

  /**
   * Rotate once the file reached the cap, before the append rather than after:
   * the live file then never holds more than one entry over the cap, and the
   * rotated copy is exactly what was too big. The previous `.1` is deleted
   * first because Windows refuses to rename onto an existing path, and one
   * backup level is all this log promises.
   */
  #rotateIfNeeded(): void {
    const st = statSync(this.#file, { throwIfNoEntry: false });
    if (!st || st.size < MAX_BYTES) return;
    const backup = `${this.#file}.1`;
    try {
      unlinkSync(backup);
    } catch {
      // No backup yet, which is the normal case.
    }
    renameSync(this.#file, backup);
    log.info('action log rotated', { file: this.#file, backup });
  }

  /**
   * Backup first, then the live file, so the concatenation is chronological.
   * The backup is read too: a rotation at 11:00 must not make this morning's
   * actions vanish from the digest at 11:05.
   */
  #readAll(): ActionEntry[] {
    const out: ActionEntry[] = [];
    for (const path of [`${this.#file}.1`, this.#file]) {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const entry = parseEntry(line);
        if (entry) out.push(entry);
      }
    }
    return out;
  }
}
