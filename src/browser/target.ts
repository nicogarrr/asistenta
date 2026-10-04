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

export async function describeTarget(
  page: Page,
  selector: string,
  timeoutMs = 2_000,
): Promise<string> {
  try {
    const loc = page.locator(selector).first();
    const text = await loc.evaluate(
      (el) => {
        const e = el as HTMLElement & { value?: string; form?: HTMLFormElement | null };
        const label = e.id
          ? (document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.textContent ?? '')
          : '';
        const form = e.form ?? e.closest('form');
        return [
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
          form?.getAttribute('action') ?? '',
          (e as HTMLAnchorElement).href ?? '',
          location.href,
        ]
          .filter(Boolean)
          .join(' | ');
      },
      undefined,
      { timeout: timeoutMs },
    );
    return text;
  } catch {
    return UNREADABLE_TARGET;
  }
}
