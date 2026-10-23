import type { Page } from 'playwright';

/**
 * What a click or keypress would act on, as text the permission gate can read.
 *
 * The model targets elements by selector ("#btn-23"), and a selector says nothing about
 * what the button does. The element's own words do: its visible text, accessible name,
 * what kind of control it is, the form it submits and where, and the page it sits on.
 * Nothing here is specific to a site; it is whatever the page says about the element.
 *
 * Returns '' when the selector matches nothing readable, and UNREADABLE when the page
 * could not be inspected, so the caller can fail closed instead of assuming it is safe.
 */
export const UNREADABLE_TARGET = '[destino ilegible]';

/**
 * One retry with a longer wait: a page that is still settling after the previous fill or
 * click makes the first read time out, and the user then gets asked about an element
 * the page would have described a second later. If the retry also fails the result is
 * still UNREADABLE, so the gate keeps failing closed.
 */
export async function describeTarget(
  page: Page,
  selector: string,
  timeoutMs = 2_000,
  retryTimeoutMs = 4_000,
): Promise<string> {
  const first = await describeOnce(page, selector, timeoutMs);
  if (first !== UNREADABLE_TARGET) return first;
  return describeOnce(page, selector, retryTimeoutMs);
}

async function describeOnce(page: Page, selector: string, timeoutMs: number): Promise<string> {
  try {
    const loc = page.locator(selector).first();
    const text = await loc.evaluate(
      (el) => {
        const e = el as HTMLElement & { value?: string; form?: HTMLFormElement | null };
        const label = e.id
          ? (document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent ?? '')
          : '';
        const form = e.form ?? e.closest('form');
        const words = [
          e.tagName.toLowerCase(),
          e.getAttribute('type') ?? '',
          (e.innerText || e.textContent || '').trim().slice(0, 120),
          e.getAttribute('aria-label') ?? '',
          e.getAttribute('title') ?? '',
          e.getAttribute('name') ?? '',
          e.getAttribute('placeholder') ?? '',
          e.getAttribute('autocomplete') ?? '',
          e.getAttribute('data-testid') ?? '',
          e.id ?? '',
          typeof e.value === 'string' && e.tagName !== 'INPUT' ? e.value : '',
          label.trim().slice(0, 80),
        ];
        // Element words first, then ' @@ ' and the places it leads to (form action, link,
        // page URL and title). The gate reads the element's words for "what does this do"
        // and the places only for money.
        const places = [
          form?.getAttribute('action') ?? '',
          (e as HTMLAnchorElement).href ?? '',
          location.href,
          document.title ?? '',
        ];
        // A control that can act inside a form or dialog that shows an amount of money: acting on
        // it may commit the user (a trial that turns into a charge, a renewal, a booking)
        // whatever the button says. Structural, no wording: currency symbol or code next
        // to a number, within the control's own form or dialog only, so a price list
        // elsewhere on the page does not count.
        const box = e.closest('form, dialog, [role="dialog"]');
        const kind = (e.getAttribute('type') ?? '').toLowerCase();
        // Any control that can act (button of any type but reset, submit/image/button input,
        // role=button, link) inside the box. A control with one character or none of its own
        // text (a quantity stepper "+" / "-") does not commit anything by itself.
        const own = (
          (e.innerText || e.textContent || '').trim() ||
          e.getAttribute('aria-label') ||
          (typeof e.value === 'string' ? e.value : '') ||
          ''
        ).trim();
        const acts =
          e.tagName === 'BUTTON'
            ? kind !== 'reset'
            : e.tagName === 'INPUT'
              ? ['submit', 'image', 'button'].includes(kind)
              : e.getAttribute('role') === 'button' ||
                (e.tagName === 'A' && e.hasAttribute('href'));
        const submits = acts && own.length > 1;
        if (box && submits) {
          const t = ((box as HTMLElement).innerText || '').slice(0, 4000);
          if (/(\d[\d.,]*\s?(€|eur|usd|gbp|chf|\$|£))|((€|\$|£)\s?\d)/i.test(t)) {
            places.push('[importe en el formulario]');
          }
        }
        return `${words.filter(Boolean).join(' | ')} @@ ${places.filter(Boolean).join(' | ')}`;
      },
      undefined,
      { timeout: timeoutMs },
    );
    return text;
  } catch {
    return UNREADABLE_TARGET;
  }
}

/**
 * The lines of the page that a person deciding on a payment would look at: totals,
 * amounts, delivery address. Taken from the page's own text, capped, and only read for
 * targets that look like money so ordinary clicks stay cheap.
 */
export async function pageSummary(page: Page, timeoutMs = 2_000): Promise<string> {
  try {
    const lines = await page.evaluate(() => {
      const re =
        /(€|\beur\b|total|subtotal|env[ií]o|entrega|direcci[oó]n|calle|avenida|plaza|c\/)/i;
      const seen = new Set<string>();
      const out: string[] = [];
      for (const raw of document.body.innerText.split('\n')) {
        const line = raw.replace(/\s+/g, ' ').trim();
        if (!line || line.length > 110 || !re.test(line) || seen.has(line)) continue;
        seen.add(line);
        out.push(line);
        if (out.length >= 10) break;
      }
      return out;
    });
    void timeoutMs;
    return lines.join('\n');
  } catch {
    return '';
  }
}
