import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';

const click = { tool: 'browser', args: { action: 'click', selector: '#a' }, actor: 'local' };
const js = {
  tool: 'browser',
  args: { action: 'exec_js', code: "fetch('/x',{method:'POST'})" },
  actor: 'local',
};

describe('a browser click grant is not a grant for exec_js', () => {
  it('session scope on browser still asks for exec_js', async () => {
    let asked = 0;
    const gate = new Gate({
      allow: [],
      approver: async () => {
        asked++;
        return false;
      },
    });
    gate.setScope('s', 'browser', 'session');
    const c = await gate.check('s', click);
    expect(c.verdict).toBe('allow'); // positive: the scope still covers ordinary browser calls
    const d = await gate.check('s', js);
    expect(asked).toBeGreaterThan(0);
    expect(d.verdict).not.toBe('allow');
  });
  it('an approved click does not open a grant window for exec_js', async () => {
    const gate = new Gate({ allow: [], approver: async (call) => call.args.action === 'click' });
    await gate.check('s', click);
    const d = await gate.check('s', js);
    expect(d.verdict).not.toBe('allow');
  });
  it('a persisted always scope on browser (DB) does not cover exec_js either', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'gate-')), 'g.db');
    let asked = 0;
    const gate = new Gate({
      allow: [],
      dbPath,
      approver: async () => {
        asked++;
        return false;
      },
    });
    gate.setScope('s', 'browser', 'always');
    expect((await gate.check('s', click)).verdict).toBe('allow');
    const d = await gate.check('s', js);
    expect(asked).toBeGreaterThan(0);
    expect(d.verdict).not.toBe('allow');
  });
});
