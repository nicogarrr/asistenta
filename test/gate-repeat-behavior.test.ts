import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';

/**
 * Behaviour map for "same call again" (no model, no real site). It states what the
 * gate does today so a change is visible; it is NOT a claim of general
 * anti-duplicate protection. The one open gap is pinned on purpose: an identical
 * call that ended cleanly is still allowed by the memo inside the same turn.
 */
describe('Gate: same call again, by situation', () => {
  const call = {
    tool: 'shell',
    args: { command: 'send-report --to team' },
    actor: 'local',
  } as const;
  const make = () => {
    let asked = 0;
    const gate = new Gate({
      approver: () => {
        asked += 1;
        return true;
      },
    });
    return { gate, asked: () => asked };
  };

  it('new user request (turn ended): the identical call asks again', async () => {
    const { gate, asked } = make();
    await gate.check('s', call);
    gate.settle('s', call, false);
    gate.clearSession('s'); // what the daemon does when the turn finishes
    await gate.check('s', call);
    expect(asked()).toBe(2);
  });

  it('retry in the same turn after an error or a missing end: asks again', async () => {
    const { gate, asked } = make();
    await gate.check('s', call);
    gate.settle('s', call, true);
    await gate.check('s', call);
    expect(asked()).toBe(2);
  });

  it('KNOWN GAP: same turn, previous run ended cleanly: the memo still allows the repeat', async () => {
    const { gate, asked } = make();
    await gate.check('s', call);
    gate.settle('s', call, false);
    const again = await gate.check('s', call);
    expect(again.reason).toContain('previously approved');
    expect(asked()).toBe(1);
  });

  it('an errand start is asked every time, even right after a clean end', async () => {
    const { gate, asked } = make();
    const go = {
      tool: 'gestion',
      args: { action: 'ejecutar', plan: 'p1' },
      actor: 'local',
    } as const;
    await gate.check('s', go);
    gate.settle('s', go, false);
    await gate.check('s', go);
    expect(asked()).toBe(2);
  });
});
