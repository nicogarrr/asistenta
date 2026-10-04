/**
 * The "Siempre" button has to mean what it says.
 *
 * `Gate` can persist an `always` scope, but only when it is handed a file, and the
 * daemon was not handing it one: the user tapped "Siempre", the bot stamped the
 * decision, and the next run of the daemon asked the identical question again. The
 * daemon looked perfectly healthy while forgetting every standing approval, which is
 * the worst way for a bug to present itself.
 *
 * So these tests go through `createDaemonGate`, the wiring the daemon actually uses,
 * rather than through `Gate` directly: the gate was never the broken part, and a test
 * that builds its own `Gate` with a `dbPath` passes against the broken daemon too.
 * A restarted daemon is modelled by constructing a second gate over the same file with
 * different thread keys, which is exactly what a new process sees.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalChoice, ApprovalScope } from '../src/channels/telegram.js';
import { approvalsDbPath, createDaemonGate } from '../src/cli.js';

const MAIN = 'telegram:main:42#main';

let dir = '';
let asked: string[] = [];

/** A click: the one call that has to be approved before a human ever sees a question. */
const click = (x: number) => ({
  tool: 'computer',
  args: { action: 'click', x, y: 1 },
  actor: 'asistenta',
});

/**
 * Stands in for the inline buttons. Records every question it is shown, so a test can
 * tell "allowed because it remembered" from "allowed because it asked again".
 */
const channel = (answer: ApprovalScope | 'refuse') => {
  return (): Promise<ApprovalChoice> => {
    asked.push('question');
    if (answer === 'refuse') return Promise.resolve({ approved: false, scope: 'once' });
    return Promise.resolve({ approved: true, scope: answer });
  };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-gate-'));
  asked = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('standing approvals across a daemon restart', () => {
  it('writes the grant to disk the moment the user taps "Siempre"', async () => {
    const gate = createDaemonGate({
      threadKey: MAIN,
      dbPath: approvalsDbPath(dir),
      ask: channel('always'),
    });
    const first = await gate.check(MAIN, click(1));
    expect(first.verdict).toBe('allow');
    expect(asked).toEqual(['question']);
    expect(gate.scopeFor(MAIN, 'computer')).toBe('always');
    // The file is the whole point: without it there is nothing to read on the next run.
    expect(existsSync(approvalsDbPath(dir))).toBe(true);
  });

  it('never asks the same question again, in any conversation, after a restart', async () => {
    const before = createDaemonGate({
      threadKey: MAIN,
      dbPath: approvalsDbPath(dir),
      ask: channel('always'),
    });
    await before.check(MAIN, click(1));

    // The restarted daemon: a second process would compute the path again and build
    // every conversation's gate from scratch. A different thread key is included on
    // purpose - the grant is about the tool, not about the conversation that asked.
    const after = createDaemonGate({
      threadKey: 'telegram:main:42#m99',
      dbPath: approvalsDbPath(dir),
      ask: channel('refuse'),
    });
    expect(after.scopeFor('telegram:main:42#m99', 'computer')).toBe('always');

    const second = await after.check('telegram:main:42#m99', click(2));
    expect(second.verdict).toBe('allow');
    // The reason is the assertion that matters: it was allowed by the stored grant, not
    // by a second question the fake channel happened to approve.
    expect(second.reason).toBe('always-allow scope');
    // One question in total. A second one here is the original bug wearing a hat.
    expect(asked).toEqual(['question']);
  });

  it('keeps `once` and `session` out of the file: approval scope is one task', async () => {
    for (const scope of ['once', 'session'] as const) {
      asked = [];
      const gate = createDaemonGate({
        threadKey: MAIN,
        dbPath: approvalsDbPath(dir),
        ask: channel(scope),
      });
      await gate.check(MAIN, click(1));

      // A new turn on a fresh daemon must ask again. A grant that outlived the task it
      // was given would let the agent act under an approval the user has forgotten.
      const next = createDaemonGate({
        threadKey: MAIN,
        dbPath: approvalsDbPath(dir),
        ask: channel('refuse'),
      });
      expect(next.scopeFor(MAIN, 'computer'), scope).toBe('unset');
      const verdict = await next.check(MAIN, click(9));
      expect(verdict.verdict, scope).toBe('deny');
      expect(asked, scope).toEqual(['question', 'question']);
    }
  });

  it('never lets a standing grant reach money or credentials', async () => {
    const gate = createDaemonGate({
      threadKey: MAIN,
      dbPath: approvalsDbPath(dir),
      ask: channel('always'),
    });
    // The grant has to be on `shell` for the exclusion to mean anything: the point is
    // that the standing grant on a tool does not extend to the calls that tool must
    // never run unattended.
    await gate.check(MAIN, { tool: 'shell', args: { command: 'Get-Date' }, actor: 'asistenta' });
    const benign = await gate.check(MAIN, {
      tool: 'shell',
      args: { command: 'Get-ChildItem' },
      actor: 'asistenta',
    });
    expect(benign.reason).toBe('always-allow scope');
    expect(asked).toHaveLength(1);

    const credential = await gate.check(MAIN, {
      tool: 'shell',
      args: { command: `type ${process.env.USERPROFILE}\\.ssh\\id_rsa` },
      actor: 'asistenta',
    });
    const payment = await gate.check(MAIN, {
      tool: 'shell',
      args: { command: 'pay card 4111111111111111' },
      actor: 'asistenta',
    });
    // Asked again, every time, even with the grant in force: a grant the model could
    // spend on a private key is a grant on everything the private key unlocks.
    expect(asked).toHaveLength(3);
    expect(credential.verdict).toBe('allow');
    expect(payment.verdict).toBe('allow');
  });

  it('still allows the call when the grant could not be written', async () => {
    const dbPath = approvalsDbPath(dir);
    const gate = createDaemonGate({ threadKey: MAIN, dbPath, ask: channel('always') });
    // A directory where the database should be: every read and write now fails, which
    // is the closest thing to a full or read-only state dir that does not need one.
    rmSync(dbPath, { force: true });
    mkdirSync(dbPath, { recursive: true });

    const verdict = await gate.check(MAIN, click(1));
    // Forgetting to remember is a nuisance the user can fix with one more tap. Refusing
    // a call the human just approved because the disk was unhappy is not.
    expect(verdict.verdict).toBe('allow');
  });

  it('keeps the approvals file inside the state dir it was given', () => {
    // The path is derived, never taken from a chat id or a thread name: a standing
    // grant is the one thing a user must not be able to redirect with a message.
    expect(approvalsDbPath(dir)).toBe(join(dir, 'approvals.db'));
    expect(approvalsDbPath(dir).startsWith(dir)).toBe(true);
  });
});

describe('createDaemonGate policy', () => {
  it('keeps the deny wall and the protected paths of the daemon', async () => {
    const gate = createDaemonGate({
      threadKey: MAIN,
      dbPath: approvalsDbPath(dir),
      ask: channel('always'),
    });
    await gate.check(MAIN, click(1));
    // `always` is a standing grant on a tool, never a way past the walls around the
    // machine: the paths the user blacked out stay blacked out.
    const write = await gate.check(MAIN, {
      tool: 'write',
      args: { path: `${process.env.USERPROFILE}\\.ssh\\id_rsa`, content: 'x' },
      actor: 'asistenta',
    });
    expect(write.verdict).toBe('deny');
  });
});
