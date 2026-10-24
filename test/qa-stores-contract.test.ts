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
});
