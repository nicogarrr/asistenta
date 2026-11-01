import type { Locator, Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { describeLocator, pageSummary, UNREADABLE_TARGET } from '../src/browser/target.js';

/**
 * Fake Page / Locator (no browser): the in-page functions run here against
 * stub globals.
 */
const g = globalThis as Record<string, unknown>;
afterEach(() => {
  delete g.document;
  delete g.location;
  delete g.CSS;
});

function pageWithText(text: string): Page {
  return {
    evaluate: async (fn: () => unknown) => {
      g.document = { body: { innerText: text } };
      return fn();
    },
  } as unknown as Page;
}

/** A submit button inside a form whose text is `formText`. */
function locatorIn(formText: string): Locator {
  const box = { innerText: formText, getAttribute: () => '/pagar' };
  const attrs: Record<string, string> = { type: 'submit' };
  const el = {
    tagName: 'BUTTON',
    id: '',
    innerText: 'Continuar',
    textContent: 'Continuar',
    form: box,
    getAttribute: (k: string) => attrs[k] ?? null,
    hasAttribute: (k: string) => k in attrs,
    closest: () => box,
  };
  const loc = {
    first: () => loc,
    evaluate: async (fn: (e: unknown, a: unknown) => unknown, arg: unknown) => {
      g.document = { title: 'Pago', querySelector: () => null };
      g.location = { href: 'https://tienda.example/pago' };
      g.CSS = { escape: (x: string) => x };
      return fn(el, arg);
    },
  };
  return loc as unknown as Locator;
}

const MARK = '[importe en el formulario]';

describe('target.ts: importes escritos con palabras', () => {
  it('pageSummary muestra «49,99 euros», «5 dólares» y «10 libras»', async () => {
    const out = await pageSummary(
      pageWithText(
        'Suscripción anual 49,99 euros\nPropina 5 dólares\nRegalo 10 libras\nEuropa 2026\nhola',
      ),
    );
    expect(out.split('\n')).toEqual([
      'Suscripción anual 49,99 euros',
      'Propina 5 dólares',
      'Regalo 10 libras',
    ]);
  });

  it('describeLocator marca importe con «dólares» en el formulario', async () => {
    expect(await describeLocator(locatorIn('Cuota mensual 5 dólares'))).toContain(MARK);
    expect(await describeLocator(locatorIn('Cuota 12,50 euros'))).toContain(MARK);
    expect(await describeLocator(locatorIn('Europa 2026, plaza 3'))).not.toContain(MARK);
  });
});

describe('describeLocator: un localizador que lanza es ilegible, no una excepción', () => {
  it('first() que lanza → UNREADABLE', async () => {
    const loc = {
      first: () => {
        throw new Error('Target page, context or browser has been closed');
      },
    } as unknown as Locator;
    await expect(describeLocator(loc)).resolves.toBe(UNREADABLE_TARGET);
  });
});
