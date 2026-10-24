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
});
