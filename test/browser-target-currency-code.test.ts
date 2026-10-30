import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { describeLocator } from '../src/browser/target.js';
import { describeBrowser } from './helpers/real-browser.js';

const MARK = '[importe en el formulario]';

describeBrowser('describeLocator: importe con el código de moneda delante', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  async function describeIn(form: string): Promise<string> {
    await page.setContent(`<!doctype html><html><body>${form}</body></html>`);
    return describeLocator(page.locator('#go'));
  }

  for (const amount of ['EUR 49,99', 'USD 5', 'CHF 10.00', 'gbp12']) {
    it(`«${amount}» en el formulario marca importe`, async () => {
      const hint = await describeIn(
        `<form action="/x"><p>A pagar: ${amount}</p><button id="go" type="submit">Continuar</button></form>`,
      );
      expect(hint).toContain(MARK);
    });
  }

  it('los formatos de siempre siguen marcando', async () => {
    for (const amount of ['25,00 €', '€25', '12,99 EUR', '$9.99']) {
      const hint = await describeIn(
        `<form action="/x"><p>Total ${amount}</p><button id="go" type="submit">Continuar</button></form>`,
      );
      expect(hint, amount).toContain(MARK);
    }
  });

  it('un formulario sin importes no se marca', async () => {
    const hint = await describeIn(
      `<form action="/x"><p>Europa 2026, plaza 3</p><button id="go" type="submit">Continuar</button></form>`,
    );
    expect(hint).not.toContain(MARK);
  });
});
