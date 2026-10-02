import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { log, redact } from './log.js';
import { stableStringify } from './utils.js';

/**
 * The permission gate. Every tool call passes through `check()` before it runs.
 *
 * Pi has no permission system by design: it runs with the permissions of whoever
 * launched it. That is acceptable for a coding agent with a human watching the
 * screen. It is unacceptable for a daemon that drives the user's mouse while they
 * sleep, so this is the one piece that is not optional and the first thing built.
 *
 * Three verdicts, not two. "Deny" would make an agent that touches the wrong
 * button useless, and "allow everything" is what Pi does today. `ask` is the
 * middle: the human approves once and the answer is remembered for the session.
 */
export type Verdict = 'allow' | 'deny' | 'ask';

/**
 * How wide one human approval is:
 *
 * - `once`    — only the exact call that was approved (the fingerprint memo).
 * - `session` — every call to that tool for the current grant window.
 * - `always`  — never ask again for that tool, even after a restart.
 *
 * Set explicitly via `Gate.setScope`; the level is a replacement, not a stack, so
 * narrowing `always` down to `once` revokes the standing grant.
 */
export type ApprovalScope = 'once' | 'session' | 'always';

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** Who asked: a Telegram user id, or 'local' for the console. */
  actor: string;
}

export interface Decision {
  verdict: Verdict;
  reason: string;
}

/** Prompts the human and resolves with their answer. */
/**
 * Sync or async on purpose: console mode has a human at the keyboard and answers
 * inline, while a channel approver has to wait for a reply and returns a promise.
 */
export type Approver = (call: ToolCall, reason: string) => boolean | Promise<boolean>;

export interface GateOptions {
  /** Tools that never need approval. */
  allow?: string[];
  /**
   * `tool:action` pairs that never need approval, e.g. `computer:screenshot`.
   * Actions of an allow-listed tool are still gated unless listed here: allowing
   * the `computer` tool must not silently permit it to click and type.
   */
  allowActions?: string[];
  /** Tools that are refused outright, before any rule matching. */
  deny?: string[];
  /** Paths the agent may never write to, matched against the resolved path. */
  protectedPaths?: string[];
  /** Max spend for a single purchase intent, in cents. */
  maxAmountCents?: number;
  /**
   * After a human approves the `computer` tool, allow further `computer` calls for
   * this long without asking again.
   *
   * Without this, one task becomes one approval per click, because every click has
   * different coordinates and the fingerprint changes. Asking once and trusting for
   * a minute is the difference between a usable agent and a tap-fest.
   *
   * Deliberately scoped to `computer` only: a window on `shell` would turn one
   * approved `echo ok` into 90 seconds of arbitrary commands. Shell relies on the
   * exact-fingerprint memo instead, so an identical command never re-asks but a
   * different one always does.
   *
   * 0 disables it. It never applies to payment-shaped or credential-shaped calls:
   * those always ask.
   */
  grantWindowMs?: number;
  /**
   * Skip every prompt and allow everything except the `deny` list.
   *
   * This is the "full control" mode: the agent clicks, types, and runs commands
   * with no confirmation, which is what you want when it is driving a known task to
   * completion. Two things survive it, and both are deliberate:
   *
   * - The `deny` list still applies. It is not a prompt, it is a wall, and a mode
   *   that could talk past it would not be a deny list.
   * - Payment-shaped calls still ask unless `allowPayments` is set explicitly. Money
   *   is the one thing where "the agent decided it was fine" is not good enough,
   *   because the recovery is a dispute with a bank rather than an undo.
   * - Credential-shaped calls (keys, vault, browser logins) ALWAYS ask, with no
   *   override flag. There is deliberately no way to auto-approve reading
   *   `id_rsa`, `vault.enc` or `Login Data`: with shell access those files decrypt
   *   to everything, so they must never pass silently.
   *
   * Every call still passes through the audit trail.
   */
  fullControl?: boolean;
  /** Required to also auto-approve payment and credential calls in full control. */
  allowPayments?: boolean;
  /**
   * SQLite file where `always` approval scopes are persisted, so a standing human
   * grant survives a restart. Injected rather than read from `paths.db` directly:
   * tests build Gates that must never touch the real database (a persisted
   * `always` for `shell` there would silently change what the tests assert).
   * Omitted means scopes live in memory only.
   */
  dbPath?: string;
  approver?: Approver;
}

/**
 * Rules are ordered; the first match wins. Keeping them a list rather than a
 * scoring function means the effective policy is readable top to bottom, which
 * matters a lot when the thing being policed can move your mouse.
 */
interface Rule {
  id: string;
  verdict: Verdict;
  reason: string;
  match: (call: ToolCall) => boolean;
}

/** A declared scope below `always`, kept per session. */
interface ScopeEntry {
  level: 'once' | 'session';
  /** Epoch ms until which a `session` scope is live; null for `once`. */
  until: number | null;
}

/** `always` scopes survive restarts in this table (see `GateOptions.dbPath`). */
const SCOPE_TABLE = `CREATE TABLE IF NOT EXISTS approval_scopes (
  scope_key  TEXT PRIMARY KEY,
  tool       TEXT,
  level      TEXT,
  created_at INTEGER
)`;

function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

/** Every argument value flattened into one string, for pattern matching. */
function blobOf(c: ToolCall): string {
  return Object.values(c.args)
    .map((v) => (typeof v === 'string' ? v : (JSON.stringify(v) ?? '')))
    .join(' ');
}

export class Gate {
  readonly #rules: Rule[];
  readonly #protected: string[];
  readonly #maxAmountCents: number;
  readonly #approver: Approver | undefined;
  readonly #fullControl: boolean;
  readonly #allowPayments: boolean;
  readonly #grantWindowMs: number;
  /** SQLite file for `always` scopes; undefined means memory only. */
  readonly #dbPath: string | undefined;
  /** Tools with a standing `always` grant. Persisted when `dbPath` is set. */
  readonly #alwaysAllow = new Set<string>();
  /** sessionId -> tool -> declared non-always scope (see `setScope`). */
  readonly #scopes = new Map<string, Map<string, ScopeEntry>>();
  /** sessionId -> (tool+args) approved. Cleared per session. */
  readonly #approved = new Map<string, Set<string>>();
  readonly #audit: Array<{
    ts: string;
    actor: string;
    tool: string;
    verdict: Verdict;
    reason: string;
  }> = [];

  constructor(options: GateOptions = {}) {
    this.#protected = (options.protectedPaths ?? []).map((p) => lexicalNormalize(p));
    this.#maxAmountCents = options.maxAmountCents ?? 30_000;
    this.#approver = options.approver;
    this.#fullControl = options.fullControl ?? false;
    this.#allowPayments = options.allowPayments ?? false;
    this.#grantWindowMs = options.grantWindowMs ?? 90_000;
    this.#dbPath = options.dbPath;
    // Standing grants from an earlier run are part of the policy, so they are
    // loaded before anything can be checked against them.
    this.#loadPersistedAlways();
    this.#rules = [
      {
        id: 'deny-tools',
        verdict: 'deny',
        reason: 'tool is on the deny list',
        match: (c) => (options.deny ?? []).includes(c.tool),
      },
      {
        id: 'allow-tools',
        verdict: 'allow',
        reason: 'tool is on the allow list',
        match: (c) => (options.allow ?? []).includes(c.tool),
      },
      {
        id: 'allow-actions',
        verdict: 'allow',
        reason: 'tool:action is on the allow list',
        match: (c) =>
          (options.allowActions ?? []).includes(`${c.tool}:${argString(c.args, 'action')}`),
      },
      {
        id: 'deny-write-protected',
        verdict: 'deny',
        reason: 'write target is a protected path',
        match: (c) => {
          if (c.tool !== 'write' && c.tool !== 'edit') return false;
          return this.#isProtected(argString(c.args, 'path'));
        },
      },
      {
        id: 'ask-payment',
        verdict: 'ask',
        reason: 'touches money or credentials',
        match: (c) => this.#isPaymentish(c),
      },
      {
        id: 'ask-credential-file',
        verdict: 'ask',
        reason: 'reads a credential store',
        match: (c) => CREDENTIAL_PATH.test(blobOf(c)),
      },
      {
        id: 'ask-computer',
        verdict: 'ask',
        reason: 'drives the desktop',
        match: (c) =>
          c.tool === 'computer' && ['click', 'type', 'key'].includes(argString(c.args, 'action')),
      },
      {
        id: 'ask-shell-destructive',
        verdict: 'ask',
        reason: 'destructive or privilege-raising shell command',
        match: (c) => c.tool === 'shell' && DESTRUCTIVE.test(argString(c.args, 'command')),
      },
      {
        id: 'ask-shell',
        verdict: 'ask',
        reason: 'runs a shell command',
        match: (c) => c.tool === 'shell',
      },
    ];
  }

  #isProtected(path: string): boolean {
    if (!path) return false;
    // Lexical normalization before comparing: `..`, mixed separators and case must
    // not smuggle a protected path past a prefix check.
    const lower = lexicalNormalize(path);
    return this.#protected.some((p) => lower === p || lower.startsWith(`${p}\\`));
  }

  #isPaymentish(c: ToolCall): boolean {
    if (c.tool === 'purchase') return true;
    const blob = blobOf(c);
    // Card-shaped numbers, with spaces and dashes stripped first: `4111 1111 1111
    // 1111` is the same number as `4111111111111111`.
    const digits = blob.replace(/[\s-]/g, '');
    return /\b\d{13,19}\b/.test(digits) || PAYMENT_WORD.test(blob);
  }

  #isCredentialish(c: ToolCall): boolean {
    return CREDENTIAL_PATH.test(blobOf(c));
  }

  #fingerprint(c: ToolCall): string {
    // Stable per (tool, args) so "approve once" means once for this exact action.
    return `${c.tool}:${stableStringify(c.args)}`;
  }

  /**
   * Whether a previous approval for this tool is still fresh. Scoped to the
   * `computer` tool only (see grantWindowMs): a window on `shell` would turn one
   * approved command into a stretch of arbitrary commands. Payment-shaped and
   * credential-shaped calls are exempt: those are asked about every single time,
   * so a trust window must never cover them.
   */
  #withinGrantWindow(sessionId: string, call: ToolCall): boolean {
    if (call.tool !== 'computer') return false;
    const until = this.#grants.get(sessionId)?.get(call.tool);
    if (until === undefined) return false;
    if (Date.now() >= until) {
      this.#grants.get(sessionId)?.delete(call.tool);
      return false;
    }
    if (this.#isPaymentish(call) || this.#isCredentialish(call)) return false;
    return true;
  }

  /** Grant the human's approval to the rest of this task, not just one call. */
  #openGrantWindow(sessionId: string, tool: string): void {
    const window = this.#grantWindowMs;
    if (window <= 0 || tool === 'purchase') return;
    // A declared `once` scope narrows an approval to its exact fingerprint:
    // opening the trust window here would widen what the human agreed to.
    if (this.#scopes.get(sessionId)?.get(tool)?.level === 'once') return;
    if (!this.#grants.has(sessionId)) this.#grants.set(sessionId, new Map());
    this.#grants.get(sessionId)?.set(tool, Date.now() + window);
  }

  /**
   * Drop every trust window and memo. Called when a task finishes, so approval
   * scope is one task rather than forever. `always` grants survive: they are a
   * standing decision, not part of any one task.
   */
  clearSession(sessionId: string): void {
    this.#approved.delete(sessionId);
    this.#grants.delete(sessionId);
    this.#scopes.delete(sessionId);
  }

  /** Tool -> epoch ms until which further calls to it are trusted. */
  #grants = new Map<string, Map<string, number>>();

  registerSession(sessionId: string): void {
    if (!this.#approved.has(sessionId)) this.#approved.set(sessionId, new Set());
  }

  /**
   * Declare how wide one human approval for `tool` is (see {@link ApprovalScope}).
   *
   * The level replaces the previous one: narrowing `always` down to `once` must
   * revoke the standing grant rather than keep it underneath, and a narrower scope
   * also cancels trust already in flight.
   */
  setScope(sessionId: string, tool: string, scope: ApprovalScope): void {
    this.#alwaysAllow.delete(tool);
    this.#dropPersistedAlways(tool);
    const perSession = this.#scopes.get(sessionId) ?? new Map<string, ScopeEntry>();
    this.#scopes.set(sessionId, perSession);
    this.#grants.get(sessionId)?.delete(tool);
    if (scope === 'always') {
      perSession.delete(tool);
      this.#alwaysAllow.add(tool);
      this.#persistAlways(tool);
      return;
    }
    if (scope === 'session') {
      // "The rest of this task" is exactly the grant window, not wall-clock forever.
      perSession.set(tool, { level: 'session', until: Date.now() + this.#grantWindowMs });
      return;
    }
    perSession.set(tool, { level: 'once', until: null });
  }

  /** The scope currently in force for `tool`, or 'unset' when none was declared. */
  scopeFor(sessionId: string, tool: string): ApprovalScope | 'unset' {
    if (this.#alwaysAllow.has(tool)) return 'always';
    const entry = this.#scopes.get(sessionId)?.get(tool);
    if (!entry) return 'unset';
    if (entry.level === 'session') {
      if (entry.until === null || Date.now() >= entry.until) {
        this.#scopes.get(sessionId)?.delete(tool);
        return 'unset';
      }
      return 'session';
    }
    return 'once';
  }

  /**
   * One open-write-close pass on the scope database. No handle is kept between
   * calls: approvals are rare and human-paced, and a second Gate over the same
   * file (tests, a restarting daemon) must never wait on a lock this one forgot.
   */
  #withScopeDb<T>(fn: (db: DatabaseSync) => T): T | undefined {
    if (!this.#dbPath) return undefined;
    mkdirSync(dirname(this.#dbPath), { recursive: true });
    const db = new DatabaseSync(this.#dbPath);
    try {
      db.exec(SCOPE_TABLE);
      return fn(db);
    } finally {
      db.close();
    }
  }

  #loadPersistedAlways(): void {
    this.#withScopeDb((db) => {
      const rows = db.prepare(`SELECT tool FROM approval_scopes WHERE level = 'always'`).all();
      for (const row of rows) {
        if (typeof row.tool === 'string') this.#alwaysAllow.add(row.tool);
      }
    });
  }

  #persistAlways(tool: string): void {
    this.#withScopeDb((db) => {
      db.prepare(
        'INSERT OR REPLACE INTO approval_scopes (scope_key, tool, level, created_at) VALUES (?, ?, ?, ?)',
      ).run(`always:${tool}`, tool, 'always', Date.now());
    });
  }

  #dropPersistedAlways(tool: string): void {
    this.#withScopeDb((db) => {
      db.prepare('DELETE FROM approval_scopes WHERE scope_key = ?').run(`always:${tool}`);
    });
  }

  async check(sessionId: string, call: ToolCall): Promise<Decision> {
    this.registerSession(sessionId);
    const approved = this.#approved.get(sessionId);
    if (!approved) throw new Error(`gate session was not registered: ${sessionId}`);

    const fp = this.#fingerprint(call);
    if (approved.has(fp)) {
      return this.#record(call, {
        verdict: 'allow',
        reason: 'previously approved in this session',
      });
    }

    // Order matters and it is deliberate: deny, then ask, then allow.
    //
    // Deny is terminal and never prompts — a deny list you can talk around by
    // asking the user is not a deny list. Ask is checked before allow because an
    // allow-list is meant to say "this tool is fine", not "this tool is fine in
    // every context": allowing `shell` must not silently permit `Remove-Item -Recurse`.
    for (const rule of this.#rules) {
      if (rule.verdict === 'deny' && rule.match(call)) {
        return this.#record(call, { verdict: 'deny', reason: rule.reason });
      }
    }

    // Explicit human scopes (`setScope`) are consulted before the approver is
    // asked: a standing grant the human already made is not a question. Deny ran
    // first above, so a scope can never talk past the deny list.
    //
    // Money and credentials sit outside every scope, same rule as the grant
    // window: an `always` grant the model could spend on `id_rsa` or a card
    // number is a standing grant on everything those unlock.
    if (!this.#isPaymentish(call) && !this.#isCredentialish(call)) {
      if (this.#alwaysAllow.has(call.tool)) {
        return this.#record(call, { verdict: 'allow', reason: 'always-allow scope' });
      }
      if (this.scopeFor(sessionId, call.tool) === 'session') {
        return this.#record(call, {
          verdict: 'allow',
          reason: 'within the session approval scope',
        });
      }
    }

    // Full control: everything the deny list does not cover runs unattended, except
    // money (unless `allowPayments`) and credentials (always). Both fall through to
    // the normal ask path rather than being denied: there may be a human in front
    // of a phone who can approve in seconds, and denying outright would make the
    // agent useless for any task that happens to touch a file with "payment" in
    // its name. Credentials have no override flag on purpose (see GateOptions).
    if (this.#fullControl) {
      const paymentish = call.tool === 'purchase' || this.#isPaymentish(call);
      if ((!paymentish || this.#allowPayments) && !this.#isCredentialish(call)) {
        return this.#record(call, { verdict: 'allow', reason: 'full control' });
      }
    }

    // A fresh grant from an earlier approval covers the rest of this task.
    if (this.#withinGrantWindow(sessionId, call)) {
      return this.#record(call, { verdict: 'allow', reason: 'within the approval window' });
    }

    // Not on the allow list and not explicitly gated: still ask. Defaulting to deny
    // would make the agent useless the moment a new tool is added, and defaulting
    // to allow would make the allow list decorative.
    const askRule = this.#rules.find((r) => r.verdict === 'ask' && r.match(call)) ?? {
      id: 'ask-unlisted',
      verdict: 'ask' as const,
      reason: 'not on the allow list',
      match: () => true,
    };

    for (const rule of this.#rules) {
      if (rule.verdict === 'allow' && rule.match(call) && askRule.id === 'ask-unlisted') {
        this.#openGrantWindow(sessionId, call.tool);
        return this.#record(call, { verdict: 'allow', reason: rule.reason });
      }
    }

    if (!this.#approver) {
      // No way to ask means we must not guess. Fail closed.
      return this.#record(call, {
        verdict: 'deny',
        reason: 'needs approval but no approver is configured (unattended run)',
      });
    }

    let ok = false;
    try {
      ok = await this.#approver(call, askRule.reason);
    } catch (err) {
      log.error('approver threw, failing closed', { tool: call.tool, ...redact({ err }) });
      ok = false;
    }
    if (!ok) return this.#record(call, { verdict: 'deny', reason: `denied by ${call.actor}` });
    approved.add(fp);
    // One approval covers the rest of this task, so a multi-step job asks once
    // instead of once per click.
    this.#openGrantWindow(sessionId, call.tool);
    return this.#record(call, { verdict: 'allow', reason: `approved by ${call.actor}` });
  }

  #record(call: ToolCall, decision: Decision): Decision {
    this.#audit.push({
      ts: new Date().toISOString(),
      actor: call.actor,
      tool: call.tool,
      verdict: decision.verdict,
      reason: decision.reason,
    });
    // Args are deliberately not logged: they can contain a typed password.
    log.info('gate', { tool: call.tool, verdict: decision.verdict, reason: decision.reason });
    return decision;
  }

  auditTrail(): ReadonlyArray<{
    ts: string;
    actor: string;
    tool: string;
    verdict: Verdict;
    reason: string;
  }> {
    return this.#audit;
  }
}

const DESTRUCTIVE =
  /\b(rm\s+-[rf]|Remove-Item|rmdir|del\s+\/|format\s|certutil|New-ItemProperty|Set-ExecutionPolicy|reg\s+delete|diskpart|takeown|icacls|Invoke-Expression|iex\s|curl\s+.*\|\s*(sh|bash)|wget\s+.*\|\s*(sh|bash))\b/i;

const PAYMENT_WORD =
  /\b(card|credit|debit|bank|payment|pay|invoice|transfer|send|wire|withdraw|deposit|crypto|\bbtc\b|\beth\b|usdc|gift|iban|checkout|buy|purchase|subscribe|billing|buy\s+now|confirm\s+order)\b/i;

/**
 * Reads of credential material always need a human, even read-only. Includes the
 * agent's own state: `vault.enc` decrypts to every secret via DPAPI-CurrentUser,
 * so reading it through `shell` must ask exactly like reading `id_rsa` does.
 */
const CREDENTIAL_PATH =
  /(\.ssh[\\/]|id_rsa|id_ed25519|\.aws[\\/]|credentials(\.json)?|\.netrc|\.npmrc|\.env\b|\.git-credentials|\.gnupg|Kerberos|ticket\.pfx|\.pfx\b|\.p12\b|wallet\.dat|vault\.enc|agent\.db|Login Data|\.kdbx\b|NTUSER\.DAT|\bSAM\b)/i;

/**
 * Lexical path normalization for comparisons: lowercase, single separator kind,
 * `.`/`..` resolved without touching the disk. Not a substitute for realpath
 * (symlinks/junctions can still lie), but it closes the trivial evasions.
 */
export function lexicalNormalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.toLowerCase().replace(/\//g, '\\').split('\\')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('\\');
}

/** Constant-time compare for shared secrets, so auth checks cannot be timed. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still burn a comparison so length is the only thing an attacker learns early.
    timingSafeEqual(randomBytes(ab.length), randomBytes(ab.length));
    return false;
  }
  return timingSafeEqual(ab, bb);
}
