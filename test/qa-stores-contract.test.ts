import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserService } from '../src/browser/service.js';

// SYNTHETIC fixture contract (qa/shop-harness/README.md). No model, no real site.
// Goal city comes from the trusted caller (this test); the selected state is read from
// the fixture's own #mine element; a different city is a FAILURE. This proves the
// fixture can tell a mismatch from a match. It does NOT cover any real website.
const PORT = 18765;
const verdict = (goalCity: string, selected: string): 'ok' | 'fail' =>
  selected.toLowerCase().includes(goalCity.toLowerCase()) ? 'ok' : 'fail';

describe('/stores fixture contract (SYNTHETIC)', () => {
  let svc: BrowserService;
  let srv: { close: () => void };
  beforeAll(async () => {
    const mod = (await import('../qa/shop-harness/shop.mjs' as string)) as {
      start: (p: number) => Promise<{ close: () => void }>;
    };
    srv = await mod.start(PORT);
    svc = new BrowserService({
      policy: { allowPrivateHosts: true, autoApprove: true, approve: async () => true },
      channel: 'chromium',
      timeoutMs: 15_000,
    });
  }, 60_000);
  afterAll(async () => {
    await svc.closeAll();
    srv.close();
  });

  const pickFirst = async (scope: string): Promise<string> => {
    await svc.open(scope, `http://127.0.0.1:${PORT}/stores?q=Plaza+Mayor`);
    await svc.clickTarget(scope, '.pick');
    await new Promise((r) => setTimeout(r, 500)); // DOM updates after the server ACK
    const r = await svc.execJs(
      scope,
      "return await page.evaluate(() => document.getElementById('mine').innerText)",
    );
    return String(r.text);
  };

  it('negative: only Mollet offered, picking it is a FAILURE for goal Gijón', async () => {
    delete process.env.SHOP_GIJON;
    const selected = await pickFirst('neg');
    expect(selected).toContain('MOLLET');
    expect(verdict('Gijón', selected)).toBe('fail');
  });

  it('positive: a Gijón store offered and picked is consistent with goal Gijón', async () => {
    process.env.SHOP_GIJON = '1';
    try {
      await svc.open('pos', `http://127.0.0.1:${PORT}/stores?q=Plaza+Mayor`);
      await svc.clickTarget('pos', '[data-id="40002"]');
      await new Promise((r) => setTimeout(r, 500)); // DOM updates after the server ACK
      const r = await svc.execJs(
        'pos',
        "return await page.evaluate(() => document.getElementById('mine').innerText)",
      );
      expect(verdict('Gijón', String(r.text))).toBe('ok');
    } finally {
      delete process.env.SHOP_GIJON;
    }
  });

  it('server-side pick record survives losing the browser session (oracle is not blind)', async () => {
    process.env.SHOP_GIJON = '1';
    try {
      const mod = (await import('../qa/shop-harness/shop.mjs' as string)) as {
        state: { picks: Array<{ name: string }> };
      };
      mod.state.picks.length = 0;
      await svc.open('srv', `http://127.0.0.1:${PORT}/stores?q=Plaza+Mayor`);
      await svc.clickTarget('srv', '[data-id="40002"]');
      await new Promise((r) => setTimeout(r, 500));
      expect(mod.state.picks.map((p) => p.name)).toEqual(['GIJON PLAZA']);
      await svc.closeAll(); // session lost: the record must remain
      expect(mod.state.picks).toHaveLength(1);
    } finally {
      delete process.env.SHOP_GIJON;
    }
  });

  it('oracle: history is kept, runs are isolated, a missing record is never no-selection', async () => {
    const { judge } = (await import('../qa/shop-harness/oracle.mjs' as string)) as {
      judge: (a: {
        goal: string;
        run: string;
        allPicks: unknown;
        sel?: string;
        offerLoads?: unknown;
      }) => {
        verdict: string;
        historyVerdict: string;
      };
    };
    const mollet = { run: 'r1', name: 'MOLLET 1', addr: 'Plaza Mayor 4, Mollet' };
    const gijon = { run: 'r1', name: 'GIJON PLAZA', addr: 'Plaza Mayor 2, Gijón' };
    const other = { run: 'r2', name: 'MOLLET 1', addr: 'Mollet' };
    // ended on Gijón but picked Mollet first: final ok, history FAIL
    const a = judge({ goal: 'Gijón', run: 'r1', allPicks: [mollet, gijon] });
    expect(a.verdict).toBe('ok');
    expect(a.historyVerdict).toContain('HISTORY-FAIL');
    // another run's pick does not leak in
    const clean = 'PRESENT:http://127.0.0.1:1/stores|clicks=0|';
    expect(
      judge({
        goal: 'Gijón',
        run: 'r1',
        allPicks: [other],
        sel: clean,
        offerLoads: [{ run: 'r1' }],
      }).verdict,
    ).toMatch(/^no-selection\(/);
    // clicks happened client-side but no server record: delivery unconfirmed, NOT no-selection
    expect(
      judge({
        goal: 'Gijón',
        run: 'r1',
        allPicks: [],
        offerLoads: [{ run: 'r1' }],
        sel: 'PRESENT:http://127.0.0.1:1/stores|clicks=1|',
      }).verdict,
    ).toBe('INVALID(oracle-delivery-unconfirmed)');
    // failed delivery on page 1 + reload of the SAME url (client counter reset): INVALID, not no-selection
    expect(
      judge({
        goal: 'Gijón',
        run: 'r1',
        allPicks: [],
        offerLoads: [{ run: 'r1' }, { run: 'r1' }],
        sel: clean,
      }).verdict,
    ).toBe('INVALID(oracle-reload-ambiguous)');
    expect(judge({ goal: 'Gijón', run: 'r1', allPicks: [], sel: clean }).verdict).toBe(
      'INVALID(oracle-loads-missing)',
    );
    // page left the fixture / session lost: INVALID, not no-selection
    expect(
      judge({ goal: 'Gijón', run: 'r1', allPicks: [], sel: 'ABSENT:about:blank' }).verdict,
    ).toBe('INVALID(oracle-state-lost)');
    // registry missing, or DOM shows a selection the record lacks: INVALID, not no-selection
    expect(judge({ goal: 'Gijón', run: 'r1', allPicks: undefined }).verdict).toBe(
      'INVALID(oracle-registry-missing)',
    );
    expect(
      judge({
        goal: 'Gijón',
        run: 'r1',
        allPicks: [],
        offerLoads: [{ run: 'r1' }],
        sel: 'PRESENT:http://127.0.0.1:1/stores|clicks=0|Mi tienda X',
      }).verdict,
    ).toBe('INVALID(oracle-record-mismatch)');
    expect(judge({ goal: 'Gijón', run: 'r1', allPicks: [mollet] }).verdict).toBe('FAIL');
  });
});
