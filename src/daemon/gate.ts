import { isAbsolute, join, resolve } from 'node:path';
import { formatApproval } from '../approval-text.js';
import type { ApprovalChoice } from '../channels/telegram.js';
import { THREAD_ALLOW_TOOLS } from '../core/toolset.js';
import { log, redact } from '../log.js';
import { paths } from '../paths.js';
import {
  approvalChatOf,
  approvalScopeKey,
  BROWSER_FREE_ACTIONS,
  Gate,
  protectedRepoPaths,
} from '../permissions.js';
import { checkoutStageOf } from '../tools/checkout.js';
import { portableSecretsFile } from '../vault.js';

export function protectedPaths(): string[] {
  const home = process.env.USERPROFILE;
  return [
    ...(home ? [`${home}\\.ssh`, `${home}\\.aws`] : []),
    'C:\\Windows\\System32',
    ...protectedRepoPaths(),
    // Writing a secret is as bad as reading it: a written approvals.db is a
    // self-granted standing approval, a written vault is a planted secret.
    ...secretStatePaths(),
  ];
}

/**
 * Files the agent must never read through a tool call: its own secrets. The
 * vault, the approvals database and the .env decrypt or grant everything
 * else; they are only ever opened by the code that owns them. The same files
 * are write-protected too (a written approvals.db is a self-granted standing
 * approval), via protectedPaths below. Note the fs tools already confine
 * paths to the cwd - this is the explicit wall for the in-cwd case (.env) and
 * defense in depth for the rest.
 */
function secretsFilePath(): string {
  const file = portableSecretsFile();
  return isAbsolute(file) || /^[a-z]:[\\/]/i.test(file) ? file : resolve(file);
}

export function secretStatePaths(): string[] {
  // El fichero de secretos del vault portátil puede vivir fuera del estado
  // (PA_SECRETS_FILE): leerlo o escribirlo es lo mismo que leer o plantar el vault.
  return [paths.state, paths.vault, approvalsDbPath(), resolve('.env'), secretsFilePath()];
}

/**
 * Where the standing human approvals are kept.
 *
 * Its own file rather than `paths.db`, for the same reason `memory.db` is separate
 * from the transcript: `Store` holds a WAL connection open on `paths.db` for the
 * whole process while the gate opens the file for the length of a single write, and
 * a second writer with no busy timeout gets `SQLITE_BUSY` instead of waiting. That
 * failure is silent and bad: raised inside the approver it converts the user's tap on
 * "Siempre" into a refusal, and raised in the gate constructor it throws while a
 * conversation is being created. A file nothing else writes to has neither problem.
 */
export function approvalsDbPath(stateDir: string = paths.state): string {
  return join(stateDir, 'approvals.db');
}

export interface DaemonGateOptions {
  /** The conversation these approvals belong to: `chatKey#thread`. */
  threadKey: string;
  /**
   * File the `always` scopes are written to and read back from. Required rather than
   * optional: forgetting it is precisely the bug this wiring exists to fix, and it is
   * invisible from the outside - the daemon keeps asking forever and looks healthy.
   */
  dbPath: string;
  /** Vault opt-in (`agent:fullControl`): unattended, except money and credentials. */
  fullControl?: boolean;
  /**
   * Publish the question and wait for the human.
   *
   * The answer carries the scope, so the choice is applied here, where it arrives:
   * `setScope` writes to disk before the tool call it just authorised even returns,
   * and the next call of the same tool is already covered.
   */
  ask: (
    threadKey: string,
    tool: string,
    reason: string,
    question?: string,
  ) => Promise<ApprovalChoice>;
  /**
   * Told while a human is being asked, because the idle watchdog has to know that
   * waiting for a person is not a stall. Optional so callers without a watchdog can
   * ignore it.
   */
  onAwaiting?: (waiting: boolean) => void;
}

/**
 * The gate the daemon arms for a conversation.
 *
 * Extracted from the daemon's closure so the whole policy - the allow list, the
 * protected paths, and above all the file the standing grants live in - can be
 * exercised without a Telegram token and a desktop. The wiring is the part that
 * breaks; the gate itself was fine.
 *
 * Approval scope has two widths, and the difference is the whole point of this file.
 * `session` and `once` die with the turn (`clearSession` at the end of every turn),
 * because approval scope is one task and never the next one. `always` is the user's
 * standing decision about a tool, so it is written to `dbPath` keyed by tool alone:
 * global, and read back by every conversation in every chat on the next run. Keying it
 * per conversation instead would be indistinguishable to the user from not persisting
 * it at all - the next message arrives in a new thread and asks again - and it would
 * silently widen into a global grant the moment two threads shared a session id.
 *
 * `always` is never consulted for money or credentials; that exclusion lives in
 * `Gate.check` and is not this file's to weaken. The same goes for the purchase charge:
 * `allowUntilPayment` lets a purchase reach its payment screen unattended and stops
 * there, because the one thing a standing grant must never be is "always pays".
 */
export function createDaemonGate(options: DaemonGateOptions): Gate {
  // The approver closes over `gate`, which is the line being executed here, so the
  // reference is live before any tool call can reach it. An approver cannot run before
  // the agent that owns this gate exists, so a holder indirection would be noise.
  const gate = new Gate({
    // «Siempre» vale solo en el chat donde se dio (no en un grupo ni en otro chat).
    approvalChat: approvalChatOf(options.threadKey),
    // The whole read-only toolset rather than a hand-kept list, so a tool added on main
    // is usable from a thread without editing this line.
    allow: THREAD_ALLOW_TOOLS,
    allowActions: [
      'computer:screenshot',
      'computer:move',
      // Navigating and operating a page does not ask: the gate still asks first for
      // money, credential fields and sending/deleting/booking elements, and exec_js
      // (arbitrary code) is not in the list.
      ...BROWSER_FREE_ACTIONS,
      // Playing audio the user already sent, and listing what is stored, are the
      // two media actions the prompt promises free ("needs no permission"). The
      // camera, the microphone and screen recording still ask, every time.
      'media:play',
      'media:list_audio',
    ],
    // Autonomous up to the last click. A purchase is a chain of ordinary browsing
    // actions, and asking about each of them is what stopped the Renfe flow before it
    // bought anything. The stage of a call is read from `checkoutStageOf`, a five-row
    // table in the tool itself, and the rules that survive this flag are in
    // permissions.ts: money, credentials, the deny list and `confirm`, which always
    // asks.
    allowUntilPayment: true,
    stageOf: checkoutStageOf,
    fullControl: options.fullControl ?? false,
    protectedPaths: protectedPaths(),
    secretPaths: secretStatePaths(),
    maxAmountCents: 30_000,
    grantWindowMs: 90_000,
    // The load-bearing line. Without it every "Siempre" dies with the process and an
    // always-on daemon re-asks for exactly what it was told never to ask again.
    dbPath: options.dbPath,
    // Approvals travel back over Telegram as inline buttons, and the idle watchdog is
    // paused while one is parked. The buttons also carry the scope: "siempre" must
    // mean always, not once per task.
    approver: async (call, reason) => {
      options.onAwaiting?.(true);
      try {
        const approval = formatApproval(call, reason);
        if (!approval.complete) {
          // Fail-closed: si la accion no cabe entera en la pregunta se deniega,
          // en vez de dejar aprobar a ciegas algo que no se ha mostrado entero.
          log.error('approval denied: action not fully displayable', {
            tool: call.tool,
            questionChars: approval.question.length,
          });
          return false;
        }
        const choice = await options.ask(options.threadKey, call.tool, reason, approval.question);
        if (choice.approved && choice.scope !== 'once') {
          try {
            gate.setScope(options.threadKey, approvalScopeKey(call), choice.scope);
          } catch (err) {
            // A grant that could not be written is a nuisance; losing the call the
            // user just approved because of it would be a bug. Carry on, and say so:
            // the next run will ask again rather than pretend the grant survived.
            log.error('approval scope not saved', {
              tool: call.tool,
              scope: choice.scope,
              dbPath: options.dbPath,
              ...redact({ err }),
            });
          }
        }
        return choice.approved;
      } finally {
        options.onAwaiting?.(false);
      }
    },
  });
  return gate;
}
