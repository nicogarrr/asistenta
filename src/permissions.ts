import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { unapprovableOperation } from './approval-text.js';
import type { EffectClass } from './gestor/effects.js';
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

/**
 * Where a call sits in a purchase flow.
 *
 * The distinction exists because buying something is a long chain of actions that
 * look exactly like the actions taken while merely browsing - open, type, click,
 * next, next - and a gate that asks about each of them stops the flow on step one.
 * That is not hypothetical: the Renfe flow died at "no pude continuar" with nothing
 * bought and no reason the model could act on. What separates a purchase from
 * browsing is one step at the very end, so the three moments are named here and the
 * policy is written once, on top of them:
 *
 * - `browse`  — find the thing and choose it. No money moves.
 * - `fill`    — put the buyer's details into the form. No money moves.
 * - `confirm` — the charge, and the legal terms that come with it. The human is here.
 *
 * Declared by the caller and never inferred from the arguments. The gate cannot tell
 * a "continue" click on a checkout page from the same click on a recipe site, and a
 * heuristic that tried would be wrong in exactly the direction that costs money.
 */
export type PurchaseStage = 'browse' | 'fill' | 'confirm';

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** Who asked: a Telegram user id, or 'local' for the console. */
  actor: string;
  /**
   * Where this call sits in a purchase flow, when the caller knows it.
   *
   * Ignored entirely unless the Gate was built with `allowUntilPayment`, so a caller
   * cannot talk a stricter gate into a laxer policy by labelling its calls.
   */
  stage?: PurchaseStage;
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
  /**
   * Files the agent must never READ through a tool call: its own secrets (the
   * vault, the approvals database, the .env). Reading them decrypts or grants
   * everything else, so they are opened only by the code that owns them. A
   * hard deny, not an ask: there is no legitimate tool-level read of a secret
   * to approve. Same resolution semantics as protectedPaths.
   */
  secretPaths?: string[];
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
   * Autonomous up to the last click.
   *
   * With this on, a call that declares a purchase stage of `browse` or `fill` runs
   * unattended: searching, choosing, filling the form and reaching the payment screen
   * stop being questions, because a purchase is made of exactly the same clicks and
   * typing as browsing, and asking about each one is what left the Renfe flow stuck
   * before it bought anything.
   *
   * What survives it, and is not negotiable:
   *
   * - **`confirm` always asks.** Not through the memo, not through a scope, not
   *   through `fullControl`, not through the grant window. Paying is the one step where
   *   "the agent decided it was fine" is not good enough: the recovery is a dispute with
   *   a bank rather than an undo. It asks whether or not the arguments happen to look
   *   like money, because the calls that matter least are the ones that say nothing.
   * - **Credentials.** Reading `id_rsa`, `vault.enc` or a card file still asks with no
   *   override. What this mode allows is filling a form with values fetched *by name
   *   from the vault*, not the model reading a file that happens to hold them.
   * - **Money-shaped arguments.** A 13-19 digit number or the word "card" anywhere in
   *   the arguments re-arms the payment rule, because a stage label is a claim and not
   *   evidence.
   * - **Destructive shell commands.** A `stage: 'browse'` label on
   *   `Remove-Item -Recurse` must not walk past the one ask rule that outranks it.
   * - **The deny list and protected paths**, which run before any of this.
   *
   * Off by default, so every gate built before this existed behaves identically.
   */
  allowUntilPayment?: boolean;
  /**
   * Resolve the purchase stage of a call the caller did not label itself.
   *
   * The agent runtime builds a `ToolCall` from `toolCall.name` plus the raw arguments
   * and never sets `stage`, so a daemon that wants stage-aware behaviour needs one
   * resolver instead of a patch in the agent core. Returning `undefined` is the safe
   * answer and the default: the call then goes through the ordinary rules, which ask.
   * A resolver that answered `browse` for an action it did not recognise would be an
   * allow by omission, which is how a purchase tool ends up being driven through a
   * stage nobody verified.
   */
  stageOf?: (call: ToolCall) => PurchaseStage | undefined;
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
/**
 * A browser fill that types straight from the vault: the key NAME is all the
 * Gate ever sees, and any vault key is credential material by definition -
 * whatever field it names (a `username` key included). This arms
 * ask-credential-field and every credential carve-out (memo, scopes,
 * fullControl, preflight) on the call.
 */
function isSecretFill(c: ToolCall): boolean {
  return c.tool === 'browser' && typeof c.args?.secret_key === 'string';
}

function blobOf(c: ToolCall): string {
  return Object.values(c.args)
    .map((v) => (typeof v === 'string' ? v : (JSON.stringify(v) ?? '')))
    .join(' ');
}

/**
 * One open-read-close pass on the scope database: the standing `always`
 * grants, sorted. The DB is the truth every live gate shares, so `/permisos`
 * lists from disk instead of trusting one process's memory. A gate built
 * without `dbPath` keeps its grants in memory only and they cannot outlive
 * the process - those never show up here, by design.
 */
export function listAlwaysGrants(dbPath: string | undefined): string[] {
  if (!dbPath) return [];
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCOPE_TABLE);
    return db
      .prepare(`SELECT tool FROM approval_scopes WHERE level = 'always' ORDER BY tool`)
      .all()
      .map((row) => String(row.tool));
  } finally {
    db.close();
  }
}

/**
 * Delete one standing grant from the shared database. Idempotent; returns
 * whether a row existed. Live gates ALSO keep a memory copy - deleting here
 * alone would leave a running daemon trusting the grant until its restart,
 * so callers pair this with `Gate.revokeAlways` on every live gate.
 */
export function deleteAlwaysGrant(dbPath: string | undefined, tool: string): boolean {
  if (!dbPath) return false;
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(SCOPE_TABLE);
    const res = db.prepare(`DELETE FROM approval_scopes WHERE scope_key = ?`).run(`always:${tool}`);
    return Number(res.changes) > 0;
  } finally {
    db.close();
  }
}

export class Gate {
  readonly #rules: Rule[];
  readonly #protected: string[];
  readonly #secrets: string[];
  readonly #maxAmountCents: number;
  readonly #approver: Approver | undefined;
  readonly #fullControl: boolean;
  readonly #allowPayments: boolean;
  readonly #allowUntilPayment: boolean;
  readonly #stageResolver: ((call: ToolCall) => PurchaseStage | undefined) | undefined;
  readonly #grantWindowMs: number;
  /** SQLite file for `always` scopes; undefined means memory only. */
  readonly #dbPath: string | undefined;
  /** Tools with a standing `always` grant. Persisted when `dbPath` is set. */
  readonly #alwaysAllow = new Set<string>();
  /** sessionId -> tool -> declared non-always scope (see `setScope`). */
  readonly #scopes = new Map<string, Map<string, ScopeEntry>>();
  /** sessionId -> (tool+args) approved. Cleared per session. */
  readonly #approved = new Map<string, Set<string>>();
  /**
   * sessionId -> forced-ask predicate (today: the gestor's effect-class
   * guard). Deliberately NOT cleared by clearSession: the gestion it guards
   * lives across turns and the predicate reads the store live, so a finished
   * gestion stops forcing on its own.
   */
  readonly #forcedAsk = new Map<string, (call: ToolCall) => string | null>();
  readonly #audit: Array<{
    ts: string;
    actor: string;
    tool: string;
    verdict: Verdict;
    reason: string;
  }> = [];

  constructor(options: GateOptions = {}) {
    // The gate's own database is a secret wherever it lives (custom dbPath
    // included), sidecars too: a written approvals.db(-wal) is a self-granted
    // standing approval.
    const dbFiles = options.dbPath
      ? [options.dbPath, `${options.dbPath}-wal`, `${options.dbPath}-shm`]
      : [];
    this.#protected = [...(options.protectedPaths ?? []), ...dbFiles].map((p) =>
      lexicalNormalize(absolutizePath(p)),
    );
    this.#secrets = [...(options.secretPaths ?? []), ...dbFiles].map((p) =>
      lexicalNormalize(absolutizePath(p)),
    );
    this.#maxAmountCents = options.maxAmountCents ?? 30_000;
    this.#approver = options.approver;
    this.#fullControl = options.fullControl ?? false;
    this.#allowPayments = options.allowPayments ?? false;
    this.#allowUntilPayment = options.allowUntilPayment ?? false;
    this.#stageResolver = options.stageOf;
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
        id: 'deny-read-secrets',
        verdict: 'deny',
        reason: 'read target is a secret file (vault, approvals db, .env)',
        match: (c) => {
          if (c.tool !== 'read') return false;
          return this.#isSecret(argString(c.args, 'path'));
        },
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
        id: 'ask-factory-install',
        verdict: 'ask',
        reason: 'installs a tool the agent built itself',
        match: (c) => c.tool === 'fabrica' && argString(c.args, 'action') === 'install',
      },
      {
        id: 'ask-goal-activate',
        verdict: 'ask',
        reason: 'activates days of autonomous work on a goal',
        match: (c) => c.tool === 'objetivo' && argString(c.args, 'action') === 'activar',
      },
      {
        id: 'ask-gestion-ejecutar',
        verdict: 'ask',
        reason: 'starts an approved errand with real-world effects',
        match: (c) => c.tool === 'gestion' && argString(c.args, 'action') === 'ejecutar',
      },
      {
        // Documented here so the effective policy reads top to bottom, but decided in
        // `check()`: the list is ordered deny-ask-allow, and an allow entry in it can
        // never outrank an ask. A purchase flow is nothing but clicks and typing, so
        // the generic "drives the desktop" and "not on the allow list" prompts would
        // stop it on step one. See `#isPreflight` and the `allowUntilPayment` docs.
        id: 'allow-preflight-stage',
        verdict: 'allow',
        reason: 'pre-payment stage of a purchase flow',
        match: (c) => this.#isPreflight(c),
      },
      {
        id: 'ask-credential-file',
        verdict: 'ask',
        reason: 'reads a credential store',
        match: (c) => CREDENTIAL_PATH.test(blobOf(c)),
      },
      {
        id: 'ask-credential-field',
        verdict: 'ask',
        reason: 'touches a password, code or card field',
        match: (c) =>
          isSecretFill(c) || (c.tool === 'browser' && BROWSER_CREDENTIAL.test(fold(blobOf(c)))),
      },
      {
        id: 'ask-browser-effect',
        verdict: 'ask',
        reason: 'the page element sends, publishes, deletes or books something',
        match: (c) => this.#isBrowserEffect(c),
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

  /**
   * The ask-browser-effect rule's match, as a method so the gestor's
   * classifyEffect reuses exactly the same evidence the rule fires on: a
   * click or Enter on an element that sends, publishes, deletes or books.
   */
  #isBrowserEffect(c: ToolCall): boolean {
    if (c.tool !== 'browser') return false;
    const action = argString(c.args, 'action');
    if (!['click', 'press'].includes(action)) return false;
    const target = argString(c.args, '_target');
    const { element, places } = splitTarget(target);
    // On a page that talks about money, any button or Enter asks.
    const type = element.split(' | ')[1] ?? '';
    const isButton =
      action === 'press' ||
      element.startsWith('button |') ||
      (element.startsWith('input |') && ['submit', 'button', 'image'].includes(type));
    if (isButton && pageSaysMoney(places)) return true;
    // Additive: a control that can act (button, role=button, link) whose own form or dialog
    // shows an amount (see describeTarget, which only adds the marker for such controls).
    if (places.includes('[importe en el formulario]')) return true;
    return target.includes('[destino ilegible]') || isEffectText(element);
  }

  #isProtected(path: string): boolean {
    if (!path) return false;
    // Resolve before comparing, with the same semantics the fs tools apply
    // (src/tools/fs.ts guardPath): `~` is the home directory and a relative
    // path resolves against the process cwd. Without this, an absolute
    // protected list is bypassed by spelling the same file relatively
    // (`write path='src/permissions.ts'`). Windows drive/UNC spellings count
    // as absolute on any host, since the daemon runs on Windows.
    const lower = this.#resolvePath(path);
    return (
      isDotEnvFile(lower) || this.#protected.some((p) => lower === p || lower.startsWith(`${p}\\`))
    );
  }

  #isSecret(path: string): boolean {
    if (!path) return false;
    const lower = this.#resolvePath(path);
    return (
      isDotEnvFile(lower) || this.#secrets.some((p) => lower === p || lower.startsWith(`${p}\\`))
    );
  }

  /**
   * Resolve a tool-call path before comparing, with the same semantics the fs
   * tools apply (src/tools/fs.ts guardPath): `~` is the home directory and a
   * relative path resolves against the process cwd. Windows drive/UNC
   * spellings count as absolute on any host, since the daemon runs on
   * Windows. Lexical normalization at the end: `..`, mixed separators and
   * case must not smuggle a protected path past a prefix check.
   */
  #resolvePath(path: string): string {
    return lexicalNormalize(absolutizePath(path));
  }

  #isPaymentish(c: ToolCall): boolean {
    if (c.tool === 'purchase') return true;
    const blob = blobOf(c);
    // Card-shaped numbers, with spaces and dashes removed from *inside* a digit run
    // first, so `4111 1111 1111 1111` is the same number as `4111111111111111`.
    //
    // Only between digits, never everywhere. Stripping every space also deletes the
    // word boundaries the pattern needs, so the digits ended up glued to whatever
    // argument preceded them (`select#x4111111111111111`) and `\b\d{13,19}\b` could
    // only ever fire for an argument that was nothing but a card number on its own. The
    // money rule was quietly inert on every multi-argument call.
    const digits = blob.replace(/(?<=\d)[ -]+(?=\d)/g, '');
    return (
      /\b\d{13,19}\b/.test(digits) ||
      PAYMENT_WORD.test(blob) ||
      // Spanish payment wording, on the tools that can actually spend money. Folded so
      // "PAGAR" and "pagar" are the same match.
      (WEB_TOOLS.has(c.tool) && PAYMENT_WORD_ES.test(fold(blob)))
    );
  }

  #isCredentialish(c: ToolCall): boolean {
    if (isSecretFill(c)) return true;
    // checkout's `selectors` are CSS ids of the buyer's own form (#dni, #email): the
    // field names are not a credential, and filling them is free by the owner's decision.
    const blob = blobOf(
      c.tool === 'checkout' ? { ...c, args: { ...c.args, selectors: undefined } } : c,
    );
    return (
      CREDENTIAL_PATH.test(blob) || (WEB_TOOLS.has(c.tool) && BROWSER_CREDENTIAL.test(fold(blob)))
    );
  }

  /**
   * The stage of a call: what the caller labelled it, or what the resolver made of it.
   *
   * An explicit `call.stage` wins over the resolver so a caller can override a tool's
   * default mapping for one call (the computer batch gate, for one, hands sub-actions
   * down as their own calls).
   */
  #stageOf(c: ToolCall): PurchaseStage | undefined {
    return c.stage ?? this.#stageResolver?.(c);
  }

  /**
   * A step that can run unattended on the way to a purchase: `browse` or `fill`.
   *
   * The exclusions are enumerated rather than assumed, because everything this returns
   * true for skips the ask rules that used to catch it, and the only two things that
   * may never be skipped are money and credentials:
   *
   * - `confirm` is never preflight. There is no third kind of step.
   * - Money-shaped or credential-shaped arguments re-arm the ordinary rules. A stage
   *   label is a claim; a card number is evidence.
   * - A destructive shell command re-arms its own rule. Nothing about a purchase gives
   *   `Remove-Item -Recurse` a pass.
   */
  #isPreflight(c: ToolCall): boolean {
    if (!this.#allowUntilPayment) return false;
    // A goal activation is NEVER preflight: the hard ask on `objetivo:activar`
    // collects a fresh human yes for days of autonomous work, and a `browse` or
    // `fill` stage - resolved or labelled by the caller - must not wave it
    // through. `gestion:ejecutar` gets the same treatment for the same reason:
    // starting an approved errand starts real-world effects in Nico's name.
    if (this.#isGoalActivate(c) || this.#isGestionEjecutar(c)) return false;
    const stage = this.#stageOf(c);
    if (stage !== 'browse' && stage !== 'fill') return false;
    if (this.#isPaymentish(c) || this.#isCredentialish(c)) return false;
    if (c.tool === 'shell' && DESTRUCTIVE.test(argString(c.args, 'command'))) return false;
    return true;
  }

  /**
   * The charge itself, as declared by the caller: a `confirm` stage.
   *
   * Every automatic allowance in `check()` refuses this. Not the fingerprint memo (so a
   * second identical purchase asks again rather than riding the first approval), not
   * `always`/`session` scopes, not `fullControl` with `allowPayments`, not the grant
   * window. Paying is the one action where a reusable grant is a standing grant on the
   * user's money.
   *
   * The money-shape of the arguments is deliberately *not* part of the test, even though
   * `ask-payment` catches most of them. A purchase confirm whose arguments happen to say
   * "tren Madrid-Barcelona 45,20" contains neither a card-shaped number nor any of the
   * payment words, so requiring that shape would leave the exact call this feature exists
   * for to be waved through by the memo. `confirm` means the charge; that is the whole
   * meaning of the word in this table.
   */
  #isPaymentConfirmation(c: ToolCall): boolean {
    if (!this.#allowUntilPayment) return false;
    return this.#stageOf(c) === 'confirm';
  }

  /**
   * Installing a factory-built tool: tool `fabrica`, action `install`. Same
   * treatment as the charge in a purchase - every automatic allowance in
   * `check()` refuses it: not the fingerprint memo (a second install of the
   * same code asks again), not `always`/`session` scopes, not `fullControl`,
   * not the grant window. Installing code the agent wrote itself is the one
   * action where a reusable grant would be a standing grant on every tool
   * the agent might invent later. Nico's rule: installs need approval.
   */
  #isFactoryInstall(c: ToolCall): boolean {
    return c.tool === 'fabrica' && argString(c.args, 'action') === 'install';
  }

  /**
   * Activating a long-haul goal: tool `objetivo`, action `activar`. Same
   * treatment as a factory install, and for the same shape of reason: one
   * click here starts DAYS of autonomous ticks that spend model quota and act
   * on Nico's behalf, so the human yes is collected fresh every time - never
   * from a memo, a scope grant, the grant window or fullControl. Nico's rule:
   * the plan gets an explicit "sí" in the thread, and this ask is what keeps
   * the model from upgrading a conversation about a goal into an active one.
   */
  #isGoalActivate(c: ToolCall): boolean {
    return c.tool === 'objetivo' && argString(c.args, 'action') === 'activar';
  }

  /**
   * Starting an approved universal errand: tool `gestion`, action `ejecutar`.
   * Same treatment as a goal activation, and for the same shape of reason: one
   * click here starts work that acts on third-party sites in Nico's name under
   * the plan he just approved, so the human yes is collected fresh every time -
   * never from a memo, a scope grant, the grant window or fullControl.
   */
  #isGestionEjecutar(c: ToolCall): boolean {
    return c.tool === 'gestion' && argString(c.args, 'action') === 'ejecutar';
  }

  /**
   * The per-session forced-ask predicate (today: the gestor's effect guard).
   * While set, every check consults it, and a non-null answer forces the ask
   * path with that reason, past the memo, scopes, fullControl and the grant
   * window. The deny list still wins: a forced ask cannot talk past a deny.
   */
  setForcedAsk(sessionId: string, predicate: ((call: ToolCall) => string | null) | null): void {
    if (predicate) this.#forcedAsk.set(sessionId, predicate);
    else this.#forcedAsk.delete(sessionId);
  }

  /**
   * The effect class of a call in the world - or null when the class cannot be
   * PROVEN. The gestor compares this against the class Nico approved for the
   * current step, and null forces an ask: opaque actions (arbitrary code in a
   * page, any shell command, a desktop click whose target is unknown, typing
   * into a third-party form, acting on a page element, booking tools,
   * factory-built tools) get positive proof or a question, never a default.
   * Only PROOF of the complete effect assigns a class: the absence of effect
   * words in a target proves nothing about what a click sends, one matched
   * regex proves nothing about the rest of a compound command, and a money
   * signal - a card-shaped number, a billing URL, payment words, a `confirm`
   * stage - on an opaque call proves presence, never completeness. The `paga`
   * class has exactly one source: `checkout`'s `confirm` action, the charge by
   * the tool's own bounded design. Note `destructivo` and `envia-terceros`
   * never come out of this function: both are provable as present, never as
   * the WHOLE effect of a call.
   */
  classifyEffect(c: ToolCall): EffectClass | null {
    // OPACITY FIRST, before any money or stage signal: payment-shaped arguments
    // or a stage label on an opaque call prove the shape is present, never
    // that the call's whole effect is paying - 'echo payment; Remove-Item x;
    // curl -X POST ...' also destroys and sends.
    switch (c.tool) {
      case 'shell':
      case 'book':
      case 'opengym':
        return null;
      case 'computer': {
        const action = argString(c.args, 'action');
        return action === 'screenshot' || action === 'move' ? 'lee' : null;
      }
      case 'tv': {
        const action = argString(c.args, 'action');
        return ['screenshot', 'state', 'apps'].includes(action) ? 'lee' : null;
      }
      case 'iphone': {
        // run/home/stop mueven un telefono real: opacos, siempre preguntan.
        const action = argString(c.args, 'action');
        return action === 'status' || action === 'setup' || action === 'screenshot' ? 'lee' : null;
      }
      case 'browser': {
        const action = argString(c.args, 'action');
        if (
          [
            'open',
            'snapshot',
            'screenshot',
            'back',
            'close',
            'wait',
            'wait_for',
            'media',
            'pick',
          ].includes(action)
        ) {
          return 'lee';
        }
        // click/press/fill/choose/exec_js or anything unlisted: the COMPLETE
        // effect of acting on a third-party page is unprovable, and money
        // words in the page, the target or the stage never change that - a
        // 'button | submit | Delete account' on a billing URL can destroy
        // under money cover, and typing into a money page can transmit on
        // every keystroke. The Gate's effect-text predicate is an ask
        // heuristic, not a classifier. No money signal classifies opacity.
        return null;
      }
      case 'checkout': {
        // The designed purchase flow: search/select/status read and choose,
        // with select refusing charge-shaped buttons by tool design, and
        // confirm IS the charge by the tool's own bounded vocabulary -
        // positive proof from the design, not a money signal. fill_passenger
        // types into a third-party page: same unprovability as browser fill.
        const action = argString(c.args, 'action');
        if (['search', 'select', 'status'].includes(action)) return 'lee';
        return action === 'confirm' ? 'paga' : null;
      }
      default:
        break;
    }
    // Factory-built and otherwise unknown tools are opaque too.
    if (!BOUNDED_EFFECT_TOOLS.has(c.tool)) return null;
    switch (c.tool) {
      // Provably without world effect: reads and the daemon's own bookkeeping
      // (the gestion/objetivo flows, memory, skills, documents, inspection).
      case 'read':
      case 'list':
      case 'done':
      case 'memory':
      case 'skills':
      case 'documents':
      case 'objetivo':
      case 'gestion':
      case 'windows':
      case 'ocr':
      case 'cargar_herramienta':
        return 'lee';
      case 'fetch': {
        const method = argString(c.args, 'method').toUpperCase();
        // GET/HEAD are reads. Anything else transmits to a third party whose
        // server-side effect cannot be proven from the client side.
        return method === '' || method === 'GET' || method === 'HEAD' ? 'lee' : null;
      }
      case 'write':
      case 'edit':
      case 'media':
      case 'fabrica':
      case 'reminder':
        return 'escribe-local';
      default:
        return null;
    }
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
    if (this.#isPaymentConfirmation(call)) return false;
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
    this.#unsettled.delete(sessionId);
    this.#grants.delete(sessionId);
    this.#scopes.delete(sessionId);
  }

  /**
   * Fingerprints of memo-approved calls that started but have not ended cleanly
   * (still running, errored, timed out, or the process never reported an end).
   * An error or timeout can still have committed an effect, so the memo must not
   * re-run the identical call silently: it asks again. Per session and in memory
   * only: a restart or a new task already clears the memo, so the next run asks
   * from scratch. Scope limit: the key is the exact (tool, args); an effect the
   * gate never saw, or the same effect via different args, is not covered.
   */
  #unsettled = new Map<string, Map<string, { inflight: number; failed: boolean }>>();

  /**
   * Report how a call that passed `check()` ended. A clean end settles one run
   * of it; an error marks the fingerprint failed until a fresh approval. The
   * memo only covers a repeat when no run of it is in flight and none failed,
   * so a clean end of one concurrent run cannot unlock the memo while another
   * identical run is still going.
   */
  settle(sessionId: string, call: ToolCall, isError: boolean): void {
    const entry = this.#unsettled.get(sessionId)?.get(this.#fingerprint(call));
    if (!entry) return;
    entry.inflight = Math.max(0, entry.inflight - 1);
    if (isError) entry.failed = true;
  }

  #isUnsettled(sessionId: string, fp: string): boolean {
    const entry = this.#unsettled.get(sessionId)?.get(fp);
    return entry !== undefined && (entry.inflight > 0 || entry.failed);
  }

  /** `fresh`: a human approval was just given, which clears an earlier failure. */
  #markStarted(sessionId: string, fp: string, fresh: boolean): void {
    if (!this.#unsettled.has(sessionId)) this.#unsettled.set(sessionId, new Map());
    const m = this.#unsettled.get(sessionId);
    const entry = m?.get(fp) ?? { inflight: 0, failed: false };
    entry.inflight += 1;
    if (fresh) entry.failed = false;
    m?.set(fp, entry);
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
    if (this.#hasAlways(tool)) return 'always';
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
   * The standing grants this gate honours: the shared database plus any
   * memory-only ones (a gate without `dbPath`).
   */
  listPersistedAlways(): string[] {
    return [...new Set([...listAlwaysGrants(this.#dbPath), ...this.#alwaysAllow])].sort();
  }

  /**
   * Take back a standing `always` grant: out of this process's memory AND out
   * of the shared database, so gates built later never see it. Every live
   * gate must hear this call - each caches its own copy - which is why
   * `/permisos revocar` fans it out to all of them. Returns whether the grant
   * existed anywhere. Narrowing a grant instead of removing it stays
   * `setScope`'s job.
   */
  revokeAlways(tool: string): boolean {
    const inMemory = this.#alwaysAllow.delete(tool);
    const inDb = deleteAlwaysGrant(this.#dbPath, tool);
    // Trust DERIVED from the revoked grant dies with it, or "te volvere a
    // pedir permiso" would be a lie until the session ended: exact-call
    // fingerprints (the `previously approved` memo), open trust windows and
    // declared scopes for THIS tool, in every session of this gate. Other
    // tools' fingerprints, windows and scopes stay untouched.
    const prefix = `${tool}:`;
    for (const fps of this.#approved.values()) {
      for (const fp of [...fps]) if (fp.startsWith(prefix)) fps.delete(fp);
    }
    for (const windows of this.#grants.values()) windows.delete(tool);
    for (const scopes of this.#scopes.values()) scopes.delete(tool);
    return inMemory || inDb;
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

  /**
   * Whether `tool` has a standing `always` grant right now. With a database the file
   * is the truth, not this gate's copy: one gate lives per conversation, so a grant
   * given ("Siempre") or revoked in one thread must be honoured by gates that were
   * built before it. The in-memory set is refreshed from the read and is only the
   * answer when there is no database or it cannot be read.
   */
  #hasAlways(tool: string): boolean {
    if (!this.#dbPath) return this.#alwaysAllow.has(tool);
    try {
      const found = this.#withScopeDb((db) => {
        const row = db
          .prepare(`SELECT 1 AS hit FROM approval_scopes WHERE scope_key = ? AND level = 'always'`)
          .get(`always:${tool}`);
        return row !== undefined;
      });
      if (found === undefined) return this.#alwaysAllow.has(tool);
      if (found) this.#alwaysAllow.add(tool);
      else this.#alwaysAllow.delete(tool);
      return found;
    } catch {
      return this.#alwaysAllow.has(tool);
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

    // The charge is decided once, here, and every automatic allowance below refuses
    // it. Read it early so the memo cannot resurrect an approval given for an earlier
    // purchase of the same thing.
    const confirmation = this.#isPaymentConfirmation(call);
    const factoryInstall = this.#isFactoryInstall(call);
    const goalActivate = this.#isGoalActivate(call);
    const gestionEjecutar = this.#isGestionEjecutar(call);
    // The gestor's per-step effect guard: a reason string here forces the ask
    // path below, past every automatic allowance. Deny rules still win.
    const forced = this.#forcedAsk.get(sessionId)?.(call) ?? null;

    const fp = this.#fingerprint(call);
    if (
      approved.has(fp) &&
      !this.#isUnsettled(sessionId, fp) &&
      !confirmation &&
      !factoryInstall &&
      !goalActivate &&
      !gestionEjecutar &&
      !forced
    ) {
      this.#markStarted(sessionId, fp, false);
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

    // Hay acciones que no se pueden aprobar con una pregunta (escribir un secreto,
    // una operación que el enmascarado alteraría, o algo demasiado largo para
    // revisarlo entero). Esas condiciones viven en el formateador, así que antes
    // solo frenaban al humano; con `always`/`session`/fullControl se saltaban.
    // Se comprueban aquí, antes de cualquier permiso permanente, para que un
    // "Siempre" no se convierta en "aprueba a ciegas".
    const unapprovable = unapprovableOperation(call);
    if (unapprovable) {
      return this.#record(call, { verdict: 'deny', reason: unapprovable });
    }

    // Rule `allow-preflight-stage`: a purchase gets to its own payment screen without
    // asking. Checked here rather than in the loop that honours allow rules, because
    // that loop only runs when no ask rule matched and a purchase flow trips the ask
    // rules on every single click.
    if (!forced && this.#isPreflight(call)) {
      return this.#record(call, {
        verdict: 'allow',
        reason: 'pre-payment stage of a purchase flow',
      });
    }

    // Explicit human scopes (`setScope`) are consulted before the approver is
    // asked: a standing grant the human already made is not a question. Deny ran
    // first above, so a scope can never talk past the deny list.
    //
    // Money and credentials sit outside every scope, same rule as the grant
    // window: an `always` grant the model could spend on `id_rsa` or a card
    // number is a standing grant on everything those unlock. The charge itself sits
    // outside them too, so "Siempre" on `checkout` never becomes "always pays".
    if (
      !this.#isPaymentish(call) &&
      !this.#isCredentialish(call) &&
      !confirmation &&
      !factoryInstall &&
      !goalActivate &&
      !gestionEjecutar &&
      !forced
    ) {
      if (this.#hasAlways(call.tool)) {
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
    // Neither has the charge: `allowPayments` is about a payment-shaped *command*,
    // and it must not become the way to make `confirm` unattended.
    if (this.#fullControl) {
      const paymentish = call.tool === 'purchase' || this.#isPaymentish(call);
      if (
        (!paymentish || this.#allowPayments) &&
        !this.#isCredentialish(call) &&
        !confirmation &&
        !factoryInstall &&
        !goalActivate &&
        !gestionEjecutar &&
        !forced
      ) {
        return this.#record(call, { verdict: 'allow', reason: 'full control' });
      }
    }

    // A fresh grant from an earlier approval covers the rest of this task.
    if (
      !factoryInstall &&
      !goalActivate &&
      !gestionEjecutar &&
      !forced &&
      this.#withinGrantWindow(sessionId, call)
    ) {
      return this.#record(call, { verdict: 'allow', reason: 'within the approval window' });
    }

    // Not on the allow list and not explicitly gated: still ask. Defaulting to deny
    // would make the agent useless the moment a new tool is added, and defaulting
    // to allow would make the allow list decorative.
    // A forced ask (the gestor's effect-class guard) names its own reason, so
    // Nico reads WHY this call exceeds the approved plan, not a generic rule.
    const askRule = forced
      ? {
          id: 'ask-gestion-effect',
          verdict: 'ask' as const,
          reason: forced,
          match: () => true,
        }
      : (this.#rules.find((r) => r.verdict === 'ask' && r.match(call)) ?? {
          id: 'ask-unlisted',
          verdict: 'ask' as const,
          reason: 'not on the allow list',
          match: () => true,
        });

    for (const rule of this.#rules) {
      if (
        rule.verdict === 'allow' &&
        !confirmation &&
        !forced &&
        rule.match(call) &&
        askRule.id === 'ask-unlisted'
      ) {
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
    this.#markStarted(sessionId, fp, true);
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

/** Lowercase and strip accents, so "Crédito" and "credito" are the same word. */
/**
 * Browser actions that never ask on their own. The rules for money, credential fields
 * and sending/deleting/booking elements are checked first and still ask; `exec_js`
 * (arbitrary code in the page) is deliberately absent.
 */
export const BROWSER_FREE_ACTIONS = [
  'open',
  'snapshot',
  'screenshot',
  'back',
  'close',
  'media',
  'click',
  'fill',
  'press',
  'choose',
].map((a) => `browser:${a}`);

/** Splits a click hint into the element's own words and the places it leads to. */
export function splitTarget(target: string): { element: string; places: string } {
  const i = target.indexOf(' @@ ');
  return i < 0
    ? { element: target, places: '' }
    : { element: target.slice(0, i), places: target.slice(i + 4) };
}

/** Tools where the Spanish money and credential vocabulary applies (checkout drives a shop). */
const WEB_TOOLS = new Set(['browser', 'computer', 'shell', 'checkout']);

/**
 * Tools whose action vocabulary is bounded and known to `classifyEffect`.
 * Anything else - a factory-built tool, a future addition - is opaque until
 * its actions are mapped here and gets the forced ask, never a default class.
 * `browser`, `checkout`, `computer`, `tv`, `shell` and the booking tools are
 * decided in `classifyEffect`'s first switch, BEFORE any money signal.
 */
const BOUNDED_EFFECT_TOOLS = new Set([
  'read',
  'list',
  'done',
  'memory',
  'skills',
  'documents',
  'objetivo',
  'gestion',
  'windows',
  'ocr',
  'cargar_herramienta',
  'fetch',
  'write',
  'edit',
  'media',
  'fabrica',
  'reminder',
]);

/**
 * Page-level money signal: checkout/payment words in the URL or title. Prices alone do
 * not count: the agent reports them instead. On such a page any button or Enter asks,
 * whatever the button says.
 */
const PAGE_PAYMENT =
  /(?<![\p{L}\p{N}])(checkout|pago|pagos|pasarela|cesta|carrito|pedido|order|orders|payment|pay|cart|basket|tramitar|tramitacion|facturacion|billing|tpv)(?![\p{L}\p{N}])/u;

export function pageSaysMoney(places: string): boolean {
  return PAGE_PAYMENT.test(fold(places));
}

export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/**
 * Spanish payment vocabulary, matched on {@link fold}ed text. `\b` is not usable with
 * non-ASCII letters, so the word edges are explicit. Deliberately broad: a false
 * positive costs one prompt, a miss costs money.
 */
const PAYMENT_WORD_ES = new RegExp(
  `(?<![\\p{L}\\p{N}])(${[
    'pagar',
    'pagas',
    'pago',
    'pagos',
    'paga',
    'abonar',
    'abono',
    'comprar',
    'compra',
    'compras',
    'pedir',
    'pedido',
    'pedidos',
    'tarjeta',
    'credito',
    'debito',
    'banco',
    'bancaria',
    'bancario',
    'transferencia',
    'transferir',
    'factura',
    'facturacion',
    'suscribir',
    'suscribirse',
    'suscripcion',
    'donar',
    'donacion',
    'propina',
    'cobro',
    'cargo',
    'tpv',
    'bizum',
    'paypal',
    'monedero',
    'saldo',
    'cvv',
    'cvc',
    'caducidad',
    'finalizar',
    'finish',
    'order now',
    'place order',
    'place your order',
    'complete order',
    'complete your order',
    'confirm order',
    'continuar al pago',
    'pasarela',
    'tramitar',
    'tramitacion',
    'realizar pedido',
    'confirmar pedido',
    'contratar',
    'alquilar',
    'reservar',
    'ir a caja',
    'caja',
    // Order verbs that were missing ("Encargar" slipped past both the gate and the checkout
    // button check) plus the commerce words of the other languages spoken in Spain and
    // Switzerland. A false positive costs one question; a miss places an order.
    'encargar',
    'encarga',
    'encargo',
    'encargos',
    'encargalo',
    'encargala',
    'solicitar pedido',
    'bestellen',
    'bestellung',
    'kaufen',
    'zahlen',
    'bezahlen',
    'commander',
    'commande',
    'acheter',
    'payer',
    'paiement',
    'ordinare',
    'ordina',
    'acquistare',
    'acquista',
  ].join('|')})(?![\\p{L}\\p{N}])`,
  'u',
);

/**
 * Actions with a lasting effect that are not money: sending, publishing, deleting,
 * booking. Used for browser clicks, where the target's own text says what it does.
 */
export const EFFECT_WORD = new RegExp(
  `(?<![\\p{L}\\p{N}])(${[
    'enviar',
    'envia',
    'send',
    'post',
    'publicar',
    'publica',
    'eliminar',
    'borrar',
    'cancelar',
    'confirmar',
    'reserva',
    'reservar',
    'registrarse',
    'darse de baja',
    'publish',
    'delete',
    'remove',
    'cancel',
    'confirm',
    'book',
    'reserve',
    'unsubscribe',
    'sign up',
  ].join('|')})(?![\\p{L}\\p{N}])`,
  'u',
);

/**
 * Password, one-time code and card-entry fields, judged from the element's own words
 * (type, name, autocomplete) and the model's args. Matched on folded text.
 */
const BROWSER_CREDENTIAL =
  /(?<![\p{L}\p{N}])(password|passwd|contrasena|clave de acceso|clave|pin|dni|nif|iban|passcode|otp|one-time-code|codigo de verificacion|current-password|new-password|cc-number|cc-csc|cc-exp|cc-name|card-number|numero de tarjeta|cvv|cvc)(?![\p{L}\p{N}])|type=["']?password/u;

/** True when the text reads like money: used to decide what a prompt should show. */
export function isPaymentText(text: string): boolean {
  return PAYMENT_WORD.test(text) || PAYMENT_WORD_ES.test(fold(text));
}

export function isEffectText(text: string): boolean {
  return EFFECT_WORD.test(fold(text));
}

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

/**
 * The repo paths the agent must never write, wherever it is installed: the
 * guardrails and the code it is actually running. The self-improve loop edits
 * this repo with the same gated tools, so the SSRF guard, the channels, the
 * audit trail, this gate, the agent loop and the built runtime are as
 * untouchable as ~/.ssh - an agent that can rewrite its own guardrails owns
 * them. The factory (src/factory) is the sanctioned way to add NEW tools: it
 * builds and runs them sandboxed instead of overwriting the live ones.
 * `root` is the repo root (usually process.cwd()). Directories match by prefix,
 * files exactly; the Gate normalizes both sides lexically.
 */
/** Repo root derived from this module's own location (src/ or dist/ both sit
 * directly under it), so the guardrails are found no matter the process cwd. */
const MODULE_REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function protectedRepoPaths(root: string = MODULE_REPO_ROOT): string[] {
  const r = root.replace(/[\\/]+$/, '');
  const src = [
    `${r}\\src\\cli.ts`,
    `${r}\\src\\core`,
    `${r}\\src\\tools\\fetch.ts`,
    `${r}\\src\\tools\\shell.ts`,
    `${r}\\src\\tools\\computer.ts`,
    `${r}\\src\\channels`,
    `${r}\\src\\log.ts`,
    `${r}\\src\\audit`,
    `${r}\\src\\permissions.ts`,
    `${r}\\src\\approval-text.ts`,
    `${r}\\src\\vault.ts`,
    `${r}\\src\\browser\\service.ts`,
    `${r}\\src\\factory\\runner.ts`,
    // Build, CI and git hooks: a write here executes on the next start/hook.
    `${r}\\.git`,
    `${r}\\.github`,
    `${r}\\package.json`,
    `${r}\\package-lock.json`,
    `${r}\\tsconfig.json`,
    `${r}\\tsconfig.build.json`,
    `${r}\\biome.json`,
  ];
  // The runtime the daemon actually executes (`pa` runs dist/cli.js): dist is
  // built from src, and a write to dist/*.js persists an altered runtime across
  // restarts exactly like a write to the source. Same vector, same wall.
  return [...src, `${r}\\dist`];
}

/**
 * Absolute form of a path coming from config or a tool call, with the same
 * semantics the fs tools apply (src/tools/fs.ts guardPath): `~` is the home
 * directory and a relative path resolves against the process cwd. Windows
 * drive/UNC spellings count as absolute on any host, since the daemon runs
 * on Windows. Configuration entries (PA_STATE_DIR may be RELATIVE) must go
 * through this too, or a relative secret dir never matches a resolved call.
 */
function absolutizePath(path: string): string {
  const expanded = path.replace(/^~(?=$|[\\/])/, homedir());
  return /^[a-zA-Z]:[\\/]/.test(expanded) || expanded.startsWith('\\\\') || isAbsolute(expanded)
    ? expanded
    : resolve(process.cwd(), expanded);
}

/** Public example files: the only .env* a tool may touch. No secrets inside. */
const ENV_PUBLIC_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template']);

/**
 * Any `.env` or `.env.*` is a secret container (credentials live in
 * .env.local, .env.production... as surely as in .env). Only public examples
 * are exempt. `normalizedPath` is the lexical-normalized (lowercase,
 * backslash) form.
 */
function isDotEnvFile(normalizedPath: string): boolean {
  const base = normalizedPath.split('\\').pop() ?? '';
  if (ENV_PUBLIC_EXAMPLES.has(base)) return false;
  return base === '.env' || base.startsWith('.env.');
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

/**
 * `/permisos`: the standing "siempre" grants, listed and taken back.
 *
 * Listing reads the shared approvals database (the truth every live gate
 * loads at construction); revoking deletes the row AND clears every live
 * gate's memory copy, because a gate built before the revoke would otherwise
 * keep trusting the grant until restart. `session`/`once` grants are not
 * listed: they die with their task on `clearSession`, so there is nothing
 * standing to show. A grant only ever covers the exact tool named - money,
 * credentials, factory installs, goal activations and `gestion ejecutar`
 * always ask regardless; that exclusion lives in `check()` and is not this
 * command's to weaken.
 */
export function runPermisosCommand(
  gates: readonly Gate[],
  dbPath: string | undefined,
  args: string,
): string {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const sub = (parts[0] ?? '').toLowerCase();
  // DB + every live gate's memory: a grant one process holds but never
  // persisted (or whose row is already gone) is still listed and revoked.
  const tools = [
    ...new Set([
      ...listAlwaysGrants(dbPath),
      ...gates.flatMap((gate) => gate.listPersistedAlways()),
    ]),
  ].sort();
  if (sub === '' || sub === 'estado') {
    if (tools.length === 0)
      return 'No me has dado ningún permiso "siempre". Los de "esta sesión" o "una vez" no salen aquí: mueren solos al terminar su tarea.';
    return (
      `Permisos "siempre" activos (${tools.length}): ${tools.join(', ')}. ` +
      'Quita uno con /permisos revocar <herramienta> o todos con /permisos revocar todo. ' +
      'Dinero, credenciales y activaciones te preguntan siempre, haya o no un "siempre".'
    );
  }
  if (sub !== 'revocar') return 'Uso: /permisos [estado] ⬦ /permisos revocar <herramienta>|todo';
  const target = parts.slice(1).join(' ').toLowerCase();
  if (target === '') return 'Uso: /permisos revocar <herramienta>|todo';
  const revokeOne = (tool: string): boolean => {
    let had = false;
    for (const gate of gates) had = gate.revokeAlways(tool) || had;
    // With zero live gates (daemon with no open threads) the row still goes.
    had = deleteAlwaysGrant(dbPath, tool) || had;
    return had;
  };
  if (target === 'todo') {
    if (tools.length === 0) return 'No había ningún permiso "siempre" que quitar.';
    for (const tool of tools) revokeOne(tool);
    return tools.length === 1
      ? `He quitado el único permiso "siempre" que había (${tools[0]}). Te volveré a pedir permiso la próxima vez.`
      : `He quitado los ${tools.length} permisos "siempre" que había (${tools.join(', ')}). Te volveré a pedir permiso la próxima vez.`;
  }
  const found = tools.find((tool) => tool.toLowerCase() === target);
  if (!found)
    return tools.length === 0
      ? `No había un permiso "siempre" para ${target}; de hecho no hay ninguno activo.`
      : `No había un permiso "siempre" para ${target}. Los activos: ${tools.join(', ')}.`;
  revokeOne(found);
  return `Permiso "siempre" de ${found} quitado. Te volveré a pedir permiso la próxima vez que haga falta.`;
}
