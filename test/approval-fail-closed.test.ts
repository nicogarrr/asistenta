/**
 * Integration: the daemon's own gate wiring, not the formatter alone. A call
 * whose approval text is not fully displayable must be denied WITHOUT the
 * channel ever being asked: a question that cannot show the action must not
 * exist, not even as a button the user could tap by mistake.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalChoice } from '../src/channels/telegram.js';
import { approvalsDbPath, createDaemonGate } from '../src/cli.js';

const MAIN = 'telegram:main:42#main';

let dir = '';
let asked = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pa-failclosed-'));
  asked = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const askCounting = (): Promise<ApprovalChoice> => {
  asked += 1;
  return Promise.resolve({ approved: true, scope: 'once' });
};

describe('fail-closed: acción no mostrable entera', () => {
  it('deniega SIN preguntar al canal (ask se llama cero veces)', async () => {
    const gate = createDaemonGate({ threadKey: MAIN, dbPath: approvalsDbPath(dir), ask: askCounting });
    const actions = Array.from({ length: 500 }, (_, i) => ({ action: 'click', x: i, y: i }));
    const verdict = await gate.check(MAIN, {
      tool: 'computer',
      args: { action: 'batch', actions },
      actor: 'asistenta',
    });
    expect(verdict.verdict).toBe('deny');
    expect(asked).toBe(0);
  });

  it('una acción mostrable sí llega a preguntar (control)', async () => {
    const gate = createDaemonGate({ threadKey: MAIN, dbPath: approvalsDbPath(dir), ask: askCounting });
    const verdict = await gate.check(MAIN, {
      tool: 'computer',
      args: { action: 'click', x: 1, y: 2 },
      actor: 'asistenta',
    });
    expect(verdict.verdict).toBe('allow');
    expect(asked).toBe(1);
  });
});
