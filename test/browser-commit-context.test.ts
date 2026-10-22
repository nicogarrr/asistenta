import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeTarget } from '../src/browser/target.js';
import { BROWSER_FREE_ACTIONS, Gate } from '../src/permissions.js';

// SYNTHETIC pages. The control's own wording is neutral on purpose: what the gate must
// react to is the structure (a submit control in a form that shows an amount), not words.
const ask = async (page: Page, sel: string) => {
  const log: string[] = [];
  const gate = new Gate({
    allow: ['read'],
    allowActions: BROWSER_FREE_ACTIONS,
    fullControl: false,
    approver: (_c, r) => {
      log.push(r);
      return false;
    },
  });
  const target = await describeTarget(page, sel);
  await gate.check('s', {
    tool: 'browser',
    args: { action: 'click', selector: sel, _target: target },
    actor: 'a',
  });
  return log.length > 0;
};

describe('submit control in a form that shows an amount asks', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('asks for a submit button next to an amount, whatever it says', async () => {
    for (const label of ['Adelante', 'Hire', 'Renovar', 'Rent now', 'Start free trial']) {
      await page.setContent(
        `<form><p>Plan Pro 9,99 €/mes</p><button id="x">${label}</button></form>`,
      );
      expect(await ask(page, '#x'), label).toBe(true);
    }
    await page.setContent(
      '<form><p>Total: $40.00</p><input id="x" type="submit" value="Go"></form>',
    );
    expect(await ask(page, '#x')).toBe(true);
  });

  it('does not ask for a search form, a price list elsewhere, or a non-submit button', async () => {
    await page.setContent(
      '<p>Oferta 9,99 €</p><form><input name="q"><button id="x">Buscar</button></form>',
    );
    expect(await ask(page, '#x')).toBe(false);
    await page.setContent(
      '<form><p>Plan 9,99 €</p><button id="x" type="button">Ver detalles</button></form>',
    );
    expect(await ask(page, '#x')).toBe(false);
    await page.setContent('<form><p>Resultados</p><button id="x">Siguiente</button></form>');
    expect(await ask(page, '#x')).toBe(false);
  });
});
