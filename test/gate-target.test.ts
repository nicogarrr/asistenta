import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { describeTarget, UNREADABLE_TARGET } from '../src/browser/target.js';
import { Gate } from '../src/permissions.js';
import { describeBrowser } from './helpers/real-browser.js';

const PAGE = `
<button id="btn-23">Realizar pedido</button>
<button id="btn-24">Ver menú</button>
<a id="lnk" href="/checkout/pago">Continuar</a>
<form action="/order/confirm"><button id="go" type="submit">Continuar</button></form>
<input id="num" name="n" autocomplete="cc-number">
<input id="city" placeholder="Ciudad">
<button id="icon" aria-label="Pagar con tarjeta"><svg width="10" height="10"></svg></button>
`;

describeBrowser('describeTarget + gate', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
  });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent(PAGE);
  });

  const asks = async (selector: string) => {
    const hint = await describeTarget(page, selector);
    let asked = false;
    const gate = new Gate({
      allow: ['browser'],
      approver: () => {
        asked = true;
        return false;
      },
    });
    // The model's own args never mention money: only the page's words do.
    await gate.check('s', {
      tool: 'browser',
      args: { action: 'click', selector, _target: hint },
      actor: 'asistenta',
    });
    return { asked, hint };
  };

  it('a cryptic selector on a "Realizar pedido" button still asks', async () => {
    expect((await asks('#btn-23')).asked).toBe(true);
  });

  it('an icon button named by aria-label is read', async () => {
    expect((await asks('#icon')).asked).toBe(true);
  });

  it('a generic "Continuar" is caught through its link target or form action', async () => {
    expect((await asks('#lnk')).asked).toBe(true);
    expect((await asks('#go')).hint).toContain('/order/confirm');
  });

  it('a card field is caught through its autocomplete attribute', async () => {
    const r = await asks('#num');
    expect(r.hint).toContain('cc-number');
  });

  it('a harmless button does not ask', async () => {
    expect((await asks('#btn-24')).asked).toBe(false);
    expect((await asks('#city')).asked).toBe(false);
  });

  it('says so when the element cannot be read', async () => {
    expect(await describeTarget(page, '#nope', 300)).toBe(UNREADABLE_TARGET);
  });
});
