/**
 * "El Astra barato": one block of text that answers "what is wrong with the daemon?".
 *
 * The design constraint is not the collection, it is the audience. The output is meant
 * to be pasted into another chat, where another agent — with no access to this
 * machine — has to fix the problem from the text alone. So the rules this file follows
 * everywhere:
 *
 * - **Evidence, not conclusions.** It never says "the screen tool is broken"; it says
 *   "`computer:screenshot` failed 12 times, last message: `screenshot timeout after
 *   30000ms`, log file: 2026-10-03.jsonl`". The reader draws the conclusion.
 * - **Concrete names.** Absolute file paths, exact error messages, the tool name, the
 *   pid. A diagnosis that says "check the logs" without naming the log is worthless.
 * - **Repetition is ranked first.** Forty identical lines are one problem, and listing
 *   them in order is how the real cause gets buried under the symptom. Repeated
 *   messages are grouped and counted, and the count is the headline.
 * - **Never throws.** This runs while the daemon is broken; being the thing that throws
 *   while everything else is on fire is not acceptable. Every section degrades to a
 *   line in `problems` and the report still comes out.
 *
 * Everything is injected (paths, clock, process liveness, thread count, wake state) so
 * the same function works in three places: inside the daemon (`/diagnose`), from a
 * standalone launcher, and from a test with a temp directory.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type ActionEntry, ActionLog } from './audit/log.js';
import type { Config } from './config.js';
import { wallHourMinute } from './datecontext.js';
import { paths, REPO_DIR } from './paths.js';
import { formatDurationMs, readHeartbeat } from './watchdog.js';

/** What the wake listener can tell us without being asked anything. */
export interface WakeStatus {
  running: boolean;
  checks?: number;
  wakeCount?: number;
  lastWakeAt?: string | null;
  /** Why the listener is not running, when the caller knows. */
  detail?: string;
}

export interface DiagnoseInput {
  /** Root of the mutable state. Every other path defaults from it. */
  stateDir?: string;
  /** Daily JSONL logs. Default `<stateDir>/log`. */
  logDir?: string;
  /** Action log. Default `<stateDir>/actions.jsonl`. */
  actionsFile?: string;
  /** Standing approvals. Default `<stateDir>/approvals.db`. Never opened if absent. */
  approvalsDb?: string;
  /** Long-term memory markdown. Default `<stateDir>/memory`. */
  memoryDir?: string;
  /** Frozen memory snapshot. Default `<stateDir>/snapshot`. */
  snapshotDir?: string;
  /** Learned skills. Default `<stateDir>/skills`. */
  skillsDir?: string;
  /** Default `<stateDir>/agent.pid`. */
  pidFile?: string;
  /** Default `<stateDir>/agent.heartbeat`. */
  heartbeatFile?: string;
  /** Default `<repo>/package.json`, read only for `version`. */
  packageJson?: string;
  /** Live threads. Only known when the caller *is* the daemon. */
  threads?: () => number;
  /** Live wake listener. Only known when the caller *is* the daemon. */
  wake?: () => WakeStatus | null;
  /** Model settings. Only needed when the caller is the daemon; skipped otherwise. */
  config?: () => Pick<Config, 'provider' | 'model' | 'baseUrl'>;
  now?: () => number;
  /** Liveness probe. Defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** How many recent turns to list. Default 10. */
  recent?: number;
  /** Window for tool health and error grouping. Default 24h. */
  windowMs?: number;
  /** How many daily log files to read, newest first. Default 3. */
  logFiles?: number;
  /** How many top repeated messages to report. Default 8. */
  topGroups?: number;
}

export interface DiagnoseState {
  pid: number | null;
  alive: boolean | null;
  startedAt: string | null;
  uptimeMs: number | null;
  heartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  version: string | null;
  node: string;
}

export interface ToolHealth {
  action: string;
  total: number;
  errors: number;
  blocked: number;
  errorRate: number;
  lastAt: string | null;
  lastTarget: string | null;
}

export interface MessageGroup {
  level: 'warn' | 'error';
  /** Normalized key, so the same problem with different ids groups together. */
  key: string;
  /** A verbatim example, never normalized: the reader needs the real message. */
  example: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface LogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  /**
   * The `err` field as text, when there is one.
   *
   * Carried because the exact failure almost never lives in `msg`: `log.ts` records
   * `log.error('unhandled rejection', { err })`, so a report that only prints `msg`
   * would say "unhandled rejection" forty times and never once say *what* was
   * unhandled. That is the difference between a symptom and a fixable fact.
   */
  detail: string | null;
}

export interface DirStats {
  dir: string;
  files: number;
  bytes: number;
  exists: boolean;
}

export interface ApprovalsInfo {
  file: string;
  present: boolean;
  total: number;
  always: string[];
  byLevel: Record<string, number>;
  problem: string | null;
}

/**
 * A type alias rather than an interface on purpose: only type aliases get an implicit
 * index signature, so this stays assignable to `Record<string, unknown>` and
 * `report.data.whatever` keeps working for callers that index it.
 */
export type DiagnoseData = {
  generatedAt: string;
  windowMs: number;
  state: DiagnoseState;
  actions: {
    file: string;
    read: number;
    inWindow: number;
    errors: number;
    recent: ActionEntry[];
    toolHealth: ToolHealth[];
  };
  log: {
    dir: string;
    files: string[];
    scanned: number;
    warn: number;
    error: number;
    grouped: MessageGroup[];
  };
  approvals: ApprovalsInfo;
  context: {
    provider: string | null;
    model: string | null;
    baseUrl: string | null;
    threads: number | null;
    wake: WakeStatus | null;
    memory: DirStats;
    snapshot: DirStats;
    skills: { dir: string; count: number; ids: string[] };
  };
  files: string[];
  problems: string[];
};

export interface DiagnoseReport {
  /** Spanish, pasteable, evidence-only. */
  text: string;
  /**
   * The same facts as objects. Intersected with `Record<string, unknown>` so it is
   * both indexable (`data.whatever`) and typed (`data.state.pid`).
   */
  data: DiagnoseData & Record<string, unknown>;
}

const HOUR_MS = 3_600_000;

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Hora de pared en PA_TIMEZONE: el informe lo lee Nico, no la zona del equipo. */
function hhmm(ts: string): string {
  return wallHourMinute(new Date(ts));
}

function iso(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString();
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means alive but not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Collapse the parts of a message that vary between occurrences.
 *
 * Ids, ports, timestamps and durations are exactly what makes two failures look like
 * two problems. After normalization, forty "update failed for chat 12345" lines and one
 * for chat 99999 are one group with a count of 41 — which is the fact that matters.
 * Digits shorter than two characters are left alone: `fatal` must not become `fatal`.
 */
export function normalizeMessage(msg: string): string {
  return msg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/0x[0-9a-f]+/gi, '0x#')
    .replace(/\b\d{2,}\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/** Group log lines by normalized message, biggest offender first. */
export function groupRepeated(entries: readonly LogEntry[], limit = 10): MessageGroup[] {
  const groups = new Map<string, MessageGroup>();
  for (const entry of entries) {
    if (entry.level !== 'warn' && entry.level !== 'error') continue;
    // The error text is part of the key: "unhandled rejection: socket hang up" and
    // "unhandled rejection: ENOENT" are different problems that share a message.
    const full = entry.detail ? `${entry.msg}: ${entry.detail}` : entry.msg;
    const key = normalizeMessage(full);
    const seen = groups.get(key);
    if (seen) {
      seen.count += 1;
      if (entry.ts < seen.firstSeen) seen.firstSeen = entry.ts;
      if (entry.ts > seen.lastSeen) seen.lastSeen = entry.ts;
      continue;
    }
    groups.set(key, {
      level: entry.level,
      key,
      example: full,
      count: 1,
      firstSeen: entry.ts,
      lastSeen: entry.ts,
    });
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1))
    .slice(0, Math.max(0, limit));
}

/**
 * Flatten the `err` field into something quotable.
 *
 * Three shapes occur in this codebase: a plain string, an `Error` flattened by
 * `redact()` into `{ name, message }`, and an object with a code. All three are
 * rendered as text; none of them are dropped, because a log line whose only detail
 * lives in `err` is a log line that cannot be diagnosed from.
 */
function errorText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return null;
  const rec = value as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof rec.message === 'string' && rec.message) parts.push(rec.message);
  else if (typeof rec.name === 'string' && rec.name) parts.push(rec.name);
  if (typeof rec.code === 'string' && rec.code) parts.push(rec.code);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Tolerant line reader: a truncated or hand-edited line is skipped, never thrown. */
function parseLogLine(line: string): LogEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const msg = rec.msg;
  if (typeof msg !== 'string' || !msg) return null;
  const level = rec.level;
  const ts = rec.ts;
  return {
    ts: typeof ts === 'string' ? ts : '',
    level: level === 'warn' || level === 'error' || level === 'debug' ? level : 'info',
    msg,
    detail: errorText(rec.err),
  };
}

function readFileSafe(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function statMs(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function dirStats(dir: string, depth = 4): DirStats {
  if (!existsSync(dir)) return { dir, files: 0, bytes: 0, exists: false };
  let files = 0;
  let bytes = 0;
  const walk = (current: string, level: number): void => {
    if (level > depth) return;
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      // Structural type rather than `Dirent`: the two `readdirSync` overloads return
      // different Dirent generics depending on the encoding, and this only needs the
      // name and whether it is a directory.
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, level + 1);
        continue;
      }
      files += 1;
      bytes += safeSize(full);
    }
  };
  walk(dir, 0);
  return { dir, files, bytes, exists: true };
}

function safeSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function kb(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function listSkillIds(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Standing approvals, read once and closed immediately.
 *
 * The file is only opened when it exists: an absent `approvals.db` is the normal state
 * of an agent nobody has approved anything on yet, and creating it as a side effect of
 * asking "how many approvals are there?" would be worse than the question.
 */
function readApprovals(file: string): ApprovalsInfo {
  const empty: ApprovalsInfo = {
    file,
    present: false,
    total: 0,
    always: [],
    byLevel: {},
    problem: null,
  };
  if (!existsSync(file)) return { ...empty, problem: `no existe ${file}` };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare('SELECT level, tool, COUNT(*) AS n FROM approval_scopes GROUP BY level, tool')
      .all();
    const byLevel: Record<string, number> = {};
    const always: string[] = [];
    let total = 0;
    for (const row of rows) {
      const level = asText(row.level);
      const n = asCount(row.n);
      total += n;
      byLevel[level] = (byLevel[level] ?? 0) + n;
      if (level === 'always') {
        const tool = asText(row.tool);
        if (tool && !always.includes(tool)) always.push(tool);
      }
    }
    return { file, present: true, total, always: always.sort(), byLevel, problem: null };
  } catch (err) {
    return {
      ...empty,
      present: true,
      problem: `no se pudo leer ${file}: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Nothing to release if the open never happened.
    }
  }
}

function section(title: string, lines: readonly string[]): string {
  return [`== ${title} ==`, ...(lines.length > 0 ? lines : ['(nada que leer)'])].join('\n');
}

/**
 * Build the report. Async because a caller running it inside the daemon will hand in
 * live getters, and a future liveness probe may want to await a WMI query; every
 * section is wrapped so neither can make this reject.
 */
export async function diagnose(deps: DiagnoseInput = {}): Promise<DiagnoseReport> {
  const stateDir = deps.stateDir ?? paths.state;
  const now = deps.now ?? Date.now;
  const at = now();
  const recent = Math.max(0, deps.recent ?? 10);
  const windowMs = Math.max(0, deps.windowMs ?? 24 * HOUR_MS);
  const topGroups = deps.topGroups ?? 8;
  const problems: string[] = [];
  const files: string[] = [];

  const pathsOf = {
    log: deps.logDir ?? join(stateDir, 'log'),
    actions: deps.actionsFile ?? join(stateDir, 'actions.jsonl'),
    approvals: deps.approvalsDb ?? join(stateDir, 'approvals.db'),
    memory: deps.memoryDir ?? join(stateDir, 'memory'),
    snapshot: deps.snapshotDir ?? join(stateDir, 'snapshot'),
    skills: deps.skillsDir ?? join(stateDir, 'skills'),
    pid: deps.pidFile ?? join(stateDir, 'agent.pid'),
    heartbeat: deps.heartbeatFile ?? join(stateDir, 'agent.heartbeat'),
    pkg: deps.packageJson ?? join(REPO_DIR, 'package.json'),
  };

  // ---- estado ---------------------------------------------------------------
  const pidText = readFileSafe(pathsOf.pid)?.trim() ?? null;
  const pid =
    pidText !== null && Number.isInteger(Number(pidText)) && Number(pidText) > 0
      ? Number(pidText)
      : null;
  if (pid !== null) files.push(pathsOf.pid);
  let alive: boolean | null = null;
  if (pid !== null) {
    try {
      alive = (deps.isAlive ?? defaultIsAlive)(pid);
    } catch (err) {
      alive = null;
      problems.push(
        `no se pudo comprobar el pid ${pid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const pidWrittenAt = statMs(pathsOf.pid);
  // The heartbeat's *content* is the beat (`lifecycle.ts` writes `Date.now()`); its
  // mtime is only a fallback for a heartbeat whose content is unreadable. Reading it
  // that way keeps this module and the watchdog agreeing on what "last beat" means.
  const beat = readHeartbeat(pathsOf.heartbeat);
  const heartbeatAt = beat.at ?? statMs(pathsOf.heartbeat);
  const state: DiagnoseState = {
    pid,
    alive,
    startedAt: iso(pidWrittenAt),
    uptimeMs: pidWrittenAt === null ? null : Math.max(0, at - pidWrittenAt),
    heartbeatAt: iso(heartbeatAt),
    heartbeatAgeMs: heartbeatAt === null ? null : Math.max(0, at - heartbeatAt),
    version: null,
    node: process.version,
  };
  const pkgText = readFileSafe(pathsOf.pkg);
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { version?: unknown };
      if (typeof pkg.version === 'string') state.version = pkg.version;
    } catch (err) {
      problems.push(
        `no se pudo leer la versión de ${pathsOf.pkg}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    problems.push(`no se encontró ${pathsOf.pkg}; no puedo decir la versión`);
  }

  // ---- acciones -------------------------------------------------------------
  const cutoff = at - windowMs;
  let read: ActionEntry[] = [];
  try {
    if (existsSync(pathsOf.actions)) files.push(pathsOf.actions);
    // ActionLog is the canonical reader: same parser as the rest of the daemon, and it
    // picks up the rotated generation too, so a rotation cannot hide the last actions.
    read = new ActionLog({ file: pathsOf.actions }).recent(2000);
  } catch (err) {
    problems.push(
      `no se pudo leer ${pathsOf.actions}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const inWindow = read.filter((e) => {
    const ts = Date.parse(e.ts);
    return Number.isFinite(ts) && ts >= cutoff;
  });
  const toolHealth = healthByTool(inWindow);
  const actions = {
    file: pathsOf.actions,
    read: read.length,
    inWindow: inWindow.length,
    errors: inWindow.filter((e) => e.result === 'error').length,
    recent: read.slice(-recent).reverse(),
    toolHealth,
  };

  // ---- log ------------------------------------------------------------------
  const logFiles: string[] = [];
  try {
    if (existsSync(pathsOf.log)) {
      logFiles.push(
        ...readdirSync(pathsOf.log)
          .filter((name) => name.endsWith('.jsonl'))
          .sort()
          .reverse()
          .slice(0, Math.max(0, deps.logFiles ?? 3))
          .map((name) => join(pathsOf.log, name)),
      );
      files.push(...logFiles);
    }
  } catch (err) {
    problems.push(
      `no se pudo listar ${pathsOf.log}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const entries: LogEntry[] = [];
  for (const file of logFiles) {
    const text = readFileSafe(file);
    if (text === null) {
      problems.push(`no se pudo leer ${file}`);
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const parsed = parseLogLine(line);
      if (parsed) entries.push(parsed);
    }
  }
  const windowEntries = entries.filter((e) => {
    const ts = Date.parse(e.ts);
    return Number.isFinite(ts) && ts >= cutoff;
  });
  const log = {
    dir: pathsOf.log,
    files: logFiles.map((f) => f.split(/[\\/]/).pop() ?? f),
    scanned: entries.length,
    warn: windowEntries.filter((e) => e.level === 'warn').length,
    error: windowEntries.filter((e) => e.level === 'error').length,
    grouped: groupRepeated(windowEntries, topGroups),
  };

  // ---- aprobaciones ---------------------------------------------------------
  const approvals = readApprovals(pathsOf.approvals);
  if (approvals.present) files.push(pathsOf.approvals);

  // ---- contexto -------------------------------------------------------------
  let model: { provider: string; model: string; baseUrl: string } | null = null;
  try {
    model = deps.config?.() ?? null;
  } catch (err) {
    problems.push(
      `no se pudo leer la configuración: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let threads: number | null = null;
  try {
    threads = deps.threads?.() ?? null;
  } catch (err) {
    problems.push(
      `no se pudo contar los hilos: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let wake: WakeStatus | null = null;
  try {
    wake = deps.wake?.() ?? null;
  } catch (err) {
    problems.push(
      `no se pudo consultar el wake word: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const skillIds = listSkillIds(pathsOf.skills);
  const context: DiagnoseData['context'] = {
    provider: model?.provider ?? null,
    model: model?.model ?? null,
    baseUrl: model?.baseUrl ?? null,
    threads,
    wake,
    memory: dirStats(pathsOf.memory),
    snapshot: dirStats(pathsOf.snapshot),
    skills: { dir: pathsOf.skills, count: skillIds.length, ids: skillIds },
  };

  const data: DiagnoseData = {
    generatedAt: new Date(at).toISOString(),
    windowMs,
    state,
    actions,
    log,
    approvals,
    context,
    files,
    problems,
  };

  return { text: renderText(data), data: data as DiagnoseData & Record<string, unknown> };
}

/**
 * Per-tool counts over the window, worst first.
 *
 * "Worst first" is errors descending and then volume, because a tool that failed once
 * out of a thousand is not interesting next to one that failed twelve times out of
 * twelve. The volume tiebreak matters: a tool used 500 times with 8 failures and a
 * tool used 8 times with 8 failures need to be comparable, and raw error count alone
 * hides the first one under the noise of a busy daemon.
 */
function healthByTool(entries: readonly ActionEntry[]): ToolHealth[] {
  const map = new Map<string, ToolHealth>();
  for (const entry of entries) {
    const seen = map.get(entry.action);
    if (seen) {
      seen.total += 1;
      if (entry.result === 'error') seen.errors += 1;
      if (entry.result === 'blocked') seen.blocked += 1;
      if (entry.ts > (seen.lastAt ?? '')) {
        seen.lastAt = entry.ts;
        seen.lastTarget = entry.target ?? null;
      }
      continue;
    }
    map.set(entry.action, {
      action: entry.action,
      total: 1,
      errors: entry.result === 'error' ? 1 : 0,
      blocked: entry.result === 'blocked' ? 1 : 0,
      errorRate: 0,
      lastAt: entry.ts,
      lastTarget: entry.target ?? null,
    });
  }
  return [...map.values()]
    .map((h) => ({ ...h, errorRate: h.total > 0 ? h.errors / h.total : 0 }))
    .sort((a, b) => b.errors - a.errors || b.total - a.total || (a.action < b.action ? -1 : 1));
}

function percent(rate: number): string {
  return `${Math.round(rate * 100)} %`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function sameAction(a: ActionEntry, b: ActionEntry): boolean {
  return (
    a.action === b.action &&
    a.result === b.result &&
    a.actor === b.actor &&
    (a.target ?? '') === (b.target ?? '') &&
    (a.detail ?? '') === (b.detail ?? '')
  );
}

/**
 * The recent-turn list, with identical consecutive entries collapsed into one line with
 * a count.
 *
 * The daemon records one line per tool used and one per reply, so thirty replies to
 * thirty messages produce thirty identical lines. Printing them would bury the two lines
 * that differ — and the whole point of this report is that the reader finds the odd one
 * out in seconds. Collapsing consecutive duplicates keeps the order and the timestamps
 * while making repetition a number instead of a wall.
 */
function recentLines(entries: readonly ActionEntry[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < entries.length) {
    let j = i + 1;
    while (j < entries.length && sameAction(entries[i] as ActionEntry, entries[j] as ActionEntry))
      j++;
    const first = entries[i];
    if (!first) break;
    const last = entries[j - 1] ?? first;
    const run = j - i;
    // One line per run, with the count and the span when there is more than one.
    const runNote = run > 1 ? ` x${run} (primera ${hhmm(last.ts)}, última ${hhmm(first.ts)})` : '';
    out.push(
      `  ${hhmm(first.ts)} ${first.actor} ${first.action}${first.target ? ` sobre ${first.target}` : ''} → ${first.result}${runNote}${first.detail ? ` — ${first.detail}` : ''}`,
    );
    i = j;
  }
  return out;
}

function renderText(data: DiagnoseData): string {
  const { state, actions, log, approvals, context } = data;
  const hours = Math.round(data.windowMs / HOUR_MS);
  const stateLines: string[] = [];
  stateLines.push(
    state.pid === null
      ? 'pid: no hay fichero de pid legible; el daemon puede no haber arrancado nunca'
      : `pid: ${state.pid} (${state.alive === true ? 'vivo' : state.alive === false ? 'MUERTO' : 'estado desconocido'})`,
  );
  if (state.startedAt) {
    stateLines.push(
      `arrancado: ${state.startedAt} (hace ${formatDurationMs(state.uptimeMs ?? 0)}); el fichero de pid se escribe al arrancar`,
    );
  }
  stateLines.push(
    state.heartbeatAt
      ? `heartbeat: ${state.heartbeatAt} (hace ${formatDurationMs(state.heartbeatAgeMs ?? 0)})`
      : 'heartbeat: no existe, el daemon no está escribiendo',
  );
  stateLines.push(`versión: ${state.version ?? 'desconocida'} · node ${state.node}`);
  stateLines.push(
    `hilos activos: ${context.threads === null ? 'no informado (esta vista no ve al daemon en marcha)' : context.threads}`,
  );
  if (context.wake === null) {
    stateLines.push('wake word: no informado desde aquí');
  } else {
    const w = context.wake;
    stateLines.push(
      `wake word: ${w.running ? 'escuchando' : `parado${w.detail ? ` (${w.detail})` : ''}`}${
        w.wakeCount === undefined
          ? ''
          : `, ${w.wakeCount} activaciones${w.lastWakeAt ? `, última ${w.lastWakeAt}` : ''}`
      }`,
    );
  }

  const actionLines: string[] = [];
  actionLines.push(
    `${actions.inWindow} ${plural(actions.inWindow, 'acción', 'acciones')} en las últimas ${hours} h (${actions.errors} con error) de ${actions.file}`,
  );
  if (actions.recent.length === 0) {
    actionLines.push('no hay ninguna acción registrada todavía');
  } else {
    actionLines.push(...recentLines(actions.recent));
  }

  const errorLines: string[] = [];
  errorLines.push(
    `${log.warn} ${plural(log.warn, 'aviso', 'avisos')} y ${log.error} ${plural(log.error, 'error', 'errores')} en las últimas ${hours} h, leídos ${log.scanned} líneas de ${log.files.length === 0 ? 'ningún log' : log.files.join(', ')}`,
  );
  if (log.grouped.length === 0) errorLines.push('no hay ni un warn ni un error en la ventana');
  for (const group of log.grouped) {
    errorLines.push(
      `  ${group.count}x ${group.level} — ${group.example} (primera ${hhmm(group.firstSeen)}, última ${hhmm(group.lastSeen)})`,
    );
  }

  const healthLines: string[] = [];
  if (actions.toolHealth.length === 0)
    healthLines.push('sin acciones en la ventana, nada que comparar');
  for (const h of actions.toolHealth.slice(0, 8)) {
    healthLines.push(
      `  ${h.action}: ${h.total} ${plural(h.total, 'acción', 'acciones')}, ${h.errors} con error (${percent(h.errorRate)}), ${h.blocked} bloqueadas — última ${h.lastAt ?? '?'}${h.lastTarget ? ` sobre ${h.lastTarget}` : ''}`,
    );
  }

  const approvalLines: string[] = [];
  if (!approvals.present) {
    approvalLines.push(`${approvals.problem ?? 'no hay base de datos de aprobaciones'}`);
  } else {
    approvalLines.push(
      `${approvals.total} ${plural(approvals.total, 'aprobación guardada', 'aprobaciones guardadas')} (${Object.entries(
        approvals.byLevel,
      )
        .map(([level, n]) => `${n} en scope "${level}"`)
        .join(', ')})`,
    );
    approvalLines.push(
      `siempre permitidas sin preguntar: ${approvals.always.length > 0 ? approvals.always.join(', ') : 'ninguna'}`,
    );
  }

  const contextLines: string[] = [];
  contextLines.push(
    context.model
      ? `modelo: ${context.model} (${context.provider}) en ${context.baseUrl}`
      : 'modelo: no informado desde aquí (esta vista no ha recibido la configuración)',
  );
  contextLines.push(
    context.memory.exists
      ? `memoria recordada: ${context.memory.files} ${plural(context.memory.files, 'fichero', 'ficheros')}, ${kb(context.memory.bytes)} en ${context.memory.dir}`
      : `memoria recordada: nada en ${context.memory.dir}`,
  );
  contextLines.push(
    context.snapshot.exists
      ? `snapshot: ${context.snapshot.files} ${plural(context.snapshot.files, 'fichero', 'ficheros')}, ${kb(context.snapshot.bytes)} en ${context.snapshot.dir}`
      : `snapshot: nada en ${context.snapshot.dir}`,
  );
  contextLines.push(
    context.skills.count > 0
      ? `skills: ${context.skills.count} en ${context.skills.dir} (${context.skills.ids.slice(0, 10).join(', ')}${context.skills.count > 10 ? ', …' : ''})`
      : `skills: ninguna en ${context.skills.dir}`,
  );

  const parts: string[] = [];
  if (state.pid === null && actions.read === 0 && log.scanned === 0 && !approvals.present) {
    parts.push(
      `Diagnóstico de Asistenta — generado ${data.generatedAt}. No hay estado que leer: parece que el daemon nunca ha arrancado o que ${stateDirHint(data)} no existe.`,
    );
  } else {
    parts.push(
      `Diagnóstico de Asistenta — generado ${data.generatedAt}. Evidencia, sin conclusiones.`,
    );
  }
  parts.push(section('ESTADO', stateLines));
  parts.push(section(`ÚLTIMOS TURNOS (${actions.recent.length} de ${actions.file})`, actionLines));
  parts.push(section(`ERRORES AGRUPADOS (ventana de ${hours} h)`, errorLines));
  parts.push(section(`SALUD POR HERRAMIENTA (ventana de ${hours} h)`, healthLines));
  parts.push(section('APROBACIONES', approvalLines));
  parts.push(section('CONTEXTO', contextLines));
  parts.push(
    section(
      'FICHEROS LEÍDOS',
      data.files.length > 0 ? data.files.map((f) => `  ${f}`) : ['  ninguno'],
    ),
  );
  parts.push(
    section(
      'PROBLEMAS AL LEER',
      data.problems.length > 0 ? data.problems.map((p) => `  ${p}`) : ['  ninguno'],
    ),
  );
  return parts.join('\n\n');
}

function stateDirHint(data: DiagnoseData): string {
  return data.actions.file.replace(/[\\/]actions\.jsonl$/, '');
}
