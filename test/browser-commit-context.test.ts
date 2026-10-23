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

  it('asks when the currency code is glued to the control text (inline content)', async () => {
    await page.setContent('<form><label>Total 500 EUR</label><button id="x">Listo</button></form>');
    expect(await ask(page, '#x')).toBe(true);
  });

  it('does not ask for a search form, a price list elsewhere, or a non-submit button', async () => {
    await page.setContent(
      '<p>Oferta 9,99 €</p><form><input name="q"><button id="x">Buscar</button></form>',
    );
    expect(await ask(page, '#x')).toBe(false);
    await page.setContent('<form><p>Resultados</p><button id="x">Siguiente</button></form>');
    expect(await ask(page, '#x')).toBe(false);
  });
});

// SYNTHETIC fixtures, not real sites. Controls other than a plain submit button, inside a
// form or dialog that shows an amount, also ask (a SPA commits with type=button, role=button
// or a link). Everything outside a priced form/dialog, and one-character controls, stays free.
describe('any acting control inside a priced form or dialog asks', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('asks for type=button, role=button and links inside a priced form or dialog', async () => {
    const boxes = [
      (c: string) => `<form><p>Plan Pro 9,99 €/mes</p>${c}</form>`,
      (c: string) => `<div role="dialog"><p>Total 40 USD</p>${c}</div>`,
      (c: string) => `<dialog open><p>Renovar por 120 €</p>${c}</dialog>`,
    ];
    const controls = [
      '<button id="x" type="button">Adelante</button>',
      '<div id="x" role="button">Listo</div>',
      '<a id="x" href="/go">Seguir</a>',
      '<input id="x" type="button" value="Vale">',
    ];
    for (const box of boxes) {
      for (const c of controls) {
        await page.setContent(box(c));
        expect(await ask(page, '#x'), box(c)).toBe(true);
      }
    }
  });

  it('negative controls stay free (navigation, search, cart steppers, no amount, reset)', async () => {
    const free = [
      '<nav><a id="x" href="/p">Productos</a></nav><p>Desde 9,99 €</p>',
      '<p>Plan 9,99 €</p><div id="x" role="button">Siguiente</div>',
      '<p>Oferta 5 €</p><a id="x" href="/cart">Carrito</a>',
      '<form><p>Resultados de búsqueda</p><a id="x" href="/p/2">Ver más</a></form>',
      '<form><p>Cantidad 2 x 9,99 €</p><button id="x" type="button">+</button></form>',
      '<form><p>Cantidad 2 x 9,99 €</p><button id="x" type="button" aria-label="-"></button></form>',
      '<form><p>Total 9,99 €</p><button id="x" type="reset">Limpiar</button></form>',
      '<form><input name="q"><button id="x" type="button">Filtrar</button></form>',
    ];
    let asked = 0;
    for (const html of free) {
      await page.setContent(html);
      if (await ask(page, '#x')) asked++;
    }
    expect(asked).toBe(0);
  });

  it('cost on these fixtures: asks only for the priced form/dialog controls', async () => {
    // A priced cart form with a stepper and a "Ver detalles" type=button: the stepper stays free,
    // the labelled button asks (extra confirmation, accepted cost; no wording list).
    await page.setContent(
      '<form><p>Cesta: 2 x 9,99 €</p><button id="s" type="button">+</button><button id="d" type="button">Ver detalles</button></form>',
    );
    expect(await ask(page, '#s')).toBe(false);
    expect(await ask(page, '#d')).toBe(true);
  });
});

describe('regression: submit/image controls keep asking whatever their length', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('icon-only or one-character submit controls in a priced form still ask', async () => {
    const html = [
      '<form><p>Total 9,99 €</p><input id="x" type="submit" value="→"></form>',
      '<form><p>Total 9,99 €</p><button id="x" type="submit"><svg width="8" height="8"></svg></button></form>',
      '<form><p>Total 9,99 €</p><button id="x">+</button></form>',
      '<form><p>Total 9,99 €</p><input id="x" type="image" src="data:," alt=""></form>',
    ];
    for (const h of html) {
      await page.setContent(h);
      expect(await ask(page, '#x'), h).toBe(true);
    }
  });
});
