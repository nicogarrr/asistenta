import { createHash } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { log } from '../log.js';
import { paths } from '../paths.js';

/**
 * Durable, tamper-evident record of every tool call.
 *
 * The action log records what happened per TURN (tool names, coarse detail). It
 * cannot answer "who approved this exact call, with which arguments, and when did
 * it finish": for an always-on agent that spends money, sends mail and drives the
 * desktop, that is the question incident response starts with.
 *
 * One JSONL line per call: tool, a HASH of the arguments (never the arguments: a
 * shell command can carry a token), the gate verdict and reason, whether the tool
 * failed, how long it ran, and when. Lines are chained: each carries the previous
 * line's hash and its own, so deleting or editing one in the middle breaks the
 * chain and `verifyCallAudit` can say where.
 *
 * Appends are best-effort: an audit write failure must never break the turn, but
 * it is logged loudly because it is a real loss of evidence.
 */

export type CallVerdict = 'allow' | 'deny';

export interface CallAuditEntry {
  /** Provider/tool-call id, so a start and its end can be correlated. */
  callId: string;
  tool: string;
  /** sha256 of the stable JSON of the arguments. Never the arguments themselves. */
  argsHash: string;
  verdict: CallVerdict;
  /** Why the gate allowed or denied it (the gate's own reason). */
  reason?: string;
  /** True when the tool itself failed. */
  isError?: boolean;
  /** Wall-clock duration in ms, when the call actually ran. */
  ms?: number;
}

export interface CallAuditLine extends CallAuditEntry {
  v: 1;
  ts: string;
  /** Hash of the previous line (empty for the first one). */
  prev: string;
  /** sha256(prev + canonical payload of this line without `h`). */
  h: string;
}

export function auditLedgerPath(): string {
  return join(paths.state, 'audit', 'calls.jsonl');
}

/** Stable JSON: object keys sorted, so the same args always hash the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/** Hash of the arguments only: what is needed to compare two calls, nothing to leak. */
export function hashArgs(args: unknown): string {
  let body: string;
  try {
    body = canonicalJson(args ?? {});
  } catch {
    body = '[unserializable]';
  }
  return createHash('sha256').update(body).digest('hex').slice(0, 32);
}

/**
 * The entry without its `undefined` fields. JSON.stringify drops them from the line on
 * disk, but `canonicalJson` used to hash them as `null`: a caller passing
 * `ms: undefined` (the agent does when a call finishes without a recorded start) wrote
 * a line whose stored hash could never be reproduced, and the whole ledger then read
 * as "corrupt" from that line on. Hash exactly what is written.
 */
function definedOnly(entry: CallAuditEntry): CallAuditEntry {
  return Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined),
  ) as unknown as CallAuditEntry;
}

/** Optional fields a line written before the fix may have hashed as `null`. */
const LEGACY_NULLABLE = ['reason', 'isError', 'ms'] as const;

/**
 * Lines appended before the fix hashed an absent optional field as `null`. Accept a
 * line whose hash matches with some of its ABSENT optional fields put back as null:
 * that is exactly what the old writer hashed, so an untouched old ledger verifies,
 * while an edited field (a present value changed, a present field removed) still
 * fails, because no combination of nulls reproduces the original value.
 */
function matchesLegacyHash(rest: Omit<CallAuditLine, 'h'>, h: string): boolean {
  const absent = LEGACY_NULLABLE.filter((key) => !(key in rest));
  for (let mask = 1; mask < 1 << absent.length; mask++) {
    const candidate: Record<string, unknown> = { ...rest };
    absent.forEach((key, i) => {
      if (mask & (1 << i)) candidate[key] = null;
    });
    if (lineHash(candidate as Omit<CallAuditLine, 'h'>) === h) return true;
  }
  return false;
}

function lineHash(entry: Omit<CallAuditLine, 'h'>): string {
  return createHash('sha256')
    .update(`${entry.prev}\n${canonicalJson(entry)}`)
    .digest('hex');
}

/** How much of the ledger tail is read at a time to find the last line. */
const TAIL_CHUNK = 64 * 1024;

/**
 * Hash of the last line. Reads only the end of the file (the ledger grows with
 * every tool call; reading all of it on each call got slower every day).
 */
function lastHash(file: string): string {
  if (!existsSync(file)) return '';
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    let start = fstatSync(fd).size;
    let tail = Buffer.alloc(0);
    while (start > 0) {
      const len = Math.min(TAIL_CHUNK, start);
      start -= len;
      const chunk = Buffer.alloc(len);
      readSync(fd, chunk, 0, len, start);
      tail = Buffer.concat([chunk, tail]);
      // Stop once a whole last line is in hand (a newline before it).
      if (tail.toString('utf8').replace(/\n+$/, '').includes('\n')) break;
    }
    const lines = tail.toString('utf8').split('\n').filter(Boolean);
    const last = lines[lines.length - 1];
    if (!last) return '';
    const parsed = JSON.parse(last) as { h?: unknown };
    return typeof parsed.h === 'string' ? parsed.h : '';
  } catch {
    // A corrupt tail must not stop new appends; the verifier will report it.
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Append one record. Never throws: the caller is a tool hook, and losing a turn
 * because the ledger disk is full would be worse than losing the line.
 */
export function appendCallAudit(entry: CallAuditEntry, file = auditLedgerPath()): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const base: Omit<CallAuditLine, 'h'> = {
      v: 1,
      ts: new Date().toISOString(),
      prev: lastHash(file),
      ...definedOnly(entry),
    };
    appendFileSync(file, `${JSON.stringify({ ...base, h: lineHash(base) })}\n`, { mode: 0o600 });
  } catch (err) {
    log.warn('call audit append failed', { err: err instanceof Error ? err.message : String(err) });
  }
}

export interface AuditVerifyResult {
  ok: boolean;
  entries: number;
  /** 1-based line where the chain broke, when it did. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Re-walk the chain and report the first line that does not match. Detects
 * edited, reordered or deleted lines (a deletion breaks the `prev` link).
 */
export function verifyCallAudit(file = auditLedgerPath()): AuditVerifyResult {
  if (!existsSync(file)) return { ok: true, entries: 0 };
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  let prev = '';
  for (let i = 0; i < lines.length; i++) {
    let line: CallAuditLine;
    try {
      line = JSON.parse(lines[i] as string) as CallAuditLine;
    } catch {
      return { ok: false, entries: i, brokenAt: i + 1, reason: 'JSON inválido' };
    }
    if (line.prev !== prev) {
      return {
        ok: false,
        entries: i,
        brokenAt: i + 1,
        reason: 'prev no coincide (línea borrada o reordenada)',
      };
    }
    const { h, ...rest } = line;
    if (h !== lineHash(rest) && !matchesLegacyHash(rest, h)) {
      return { ok: false, entries: i, brokenAt: i + 1, reason: 'hash no coincide (línea editada)' };
    }
    prev = h;
  }
  return { ok: true, entries: lines.length };
}
