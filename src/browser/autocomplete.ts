/**
 * Generic autocomplete handling: type, open the suggestion list, pick the right
 * suggestion, and verify by reading the field back.
 *
 * Nothing here knows a site. Suggestion lists are found the way a person finds them,
 * by what they look like, in this order: the list the input itself points to
 * (aria-controls / aria-owns / list=), any visible role=option, and finally visible
 * list-like items that sit just under the input. The choice is made by text, never by
 * position, and it never guesses between equally good matches: it hands the list back
 * so the caller (the model) can say which one it wants.
 */
import type { Page } from 'playwright';

/** Lowercase, no accents, single spaces: "Madrid-Chamartín" ~ "madrid chamartin". */
export function normalizeText(t: string): string {
  return t
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export type MatchTier = 'exact' | 'starts' | 'words' | 'includes';

const TIERS: MatchTier[] = ['exact', 'starts', 'words', 'includes'];

function tierOf(wanted: string, option: string): MatchTier | null {
  const w = normalizeText(wanted);
  const o = normalizeText(option);
  if (!w || !o) return null;
  if (o === w) return 'exact';
  if (o.startsWith(w)) return 'starts';
  const words = w.split(' ');
  if (words.every((x) => o.split(' ').includes(x))) return 'words';
  if (o.includes(w)) return 'includes';
  return null;
}

export type Pick =
  | { kind: 'one'; index: number; tier: MatchTier }
  | { kind: 'ambiguous'; indexes: number[]; tier: MatchTier }
  | { kind: 'none' };

/**
 * Choose among suggestion texts. One match in the best tier wins. Several in the
 * best tier is ambiguous, except a single `exact` which always wins over looser ones.
 */
export function pickSuggestion(wanted: string, options: readonly string[]): Pick {
  for (const tier of TIERS) {
    const hits = options.flatMap((o, i) => (tierOf(wanted, o) === tier ? [i] : []));
    if (hits.length === 1) return { kind: 'one', index: hits[0] as number, tier };
    if (hits.length > 1) return { kind: 'ambiguous', indexes: hits, tier };
  }
  return { kind: 'none' };
}

/**
 * The classic failure: typing into a field that already had text, or a widget that
 * re-inserts it, leaves "MadridMadrid". True when the value is the typed text
 * repeated back to back.
 */
export function looksDuplicated(value: string, typed: string): boolean {
  const v = normalizeText(value).replace(/ /g, '');
  const t = normalizeText(typed).replace(/ /g, '');
  if (!t || v.length < t.length * 2) return false;
  return v.startsWith(t + t);
}

export interface ChooseResult {
  ok: boolean;
  /** Spanish, for the model to relay or act on. */
  message: string;
  value: string;
  suggestions: string[];
}

interface Candidate {
  text: string;
}

const MARK = 'data-pa-suggestion';

/** Find visible suggestions for `input` and tag them so one can be clicked by index. */
async function collectSuggestions(page: Page, selector: string): Promise<Candidate[]> {
  return page.evaluate(
    ({ selector, mark }) => {
      const input = document.querySelector(selector) as HTMLElement | null;
      for (const e of Array.from(document.querySelectorAll(`[${mark}]`))) e.removeAttribute(mark);
      if (!input) return [];
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      let found: Element[] = [];

      // 1. The list the input points to.
      const ids = [input.getAttribute('aria-controls'), input.getAttribute('aria-owns')]
        .filter(Boolean)
        .join(' ')
        .split(/\s+/)
        .filter(Boolean);
      for (const id of ids) {
        const list = document.getElementById(id);
        if (!list) continue;
        const opts = Array.from(list.querySelectorAll('[role=option], li, [role=row]')).filter(
          visible,
        );
        found = found.concat(opts.length ? opts : visible(list) ? [list] : []);
      }
      // 2. Any visible role=option.
      if (!found.length)
        found = Array.from(document.querySelectorAll('[role=option]')).filter(visible);
      // 3. List-like items just under (or over) the input.
      if (!found.length) {
        const ir = input.getBoundingClientRect();
        found = Array.from(
          document.querySelectorAll(
            'li, a, div, span, p, [class*=suggest i], [class*=option i], [class*=autocomplete i], [class*=result i], [class*=item i]',
          ),
        ).filter((el) => {
          // Generic tags only count inside a floating popup (absolute/fixed ancestor);
          // named list items count anywhere under the input.
          const named = el.matches(
            'li, [class*=suggest i], [class*=option i], [class*=autocomplete i], [class*=result i], [class*=item i]',
          );
          if (!named) {
            let p: Element | null = el.parentElement;
            let floating = false;
            while (p && p !== document.body) {
              const pos = getComputedStyle(p).position;
              if (pos === 'absolute' || pos === 'fixed') {
                floating = true;
                break;
              }
              p = p.parentElement;
            }
            if (!floating) return false;
          }
          if (!visible(el) || input.contains(el) || el.contains(input)) return false;
          const r = el.getBoundingClientRect();
          const near = r.top >= ir.bottom - 8 && r.top <= ir.bottom + 600;
          const overlaps = r.left < ir.right && r.right > ir.left;
          // Leaves only: a container that holds other candidates is not a suggestion.
          const leaf = !el.querySelector('li, [role=option]');
          return near && overlaps && leaf && text(el).length > 0 && text(el).length < 160;
        });
      }
      const out: Array<{ text: string }> = [];
      for (const el of found.slice(0, 30)) {
        const t = text(el);
        if (!t) continue;
        el.setAttribute(mark, String(out.length));
        out.push({ text: t });
      }
      return out;
    },
    { selector, mark: MARK },
  );
}

/**
 * Type `text` into the field matching `selector`, wait for suggestions, pick the one
 * matching `option` (default: `text`) and verify the field. Never claims success it
 * has not read back.
 */
export async function chooseSuggestion(
  page: Page,
  selector: string,
  text: string,
  option?: string,
  opts: { settleMs?: number; waitMs?: number } = {},
): Promise<ChooseResult> {
  const input = page.locator(selector).first();
  await input.click();
  await input.press('Control+A');
  await input.press('Delete');
  await input.pressSequentially(text, { delay: 40 });

  const deadline = Date.now() + (opts.waitMs ?? 6_000);
  let found: Candidate[] = [];
  while (Date.now() < deadline) {
    await page.waitForTimeout(opts.settleMs ?? 400);
    found = await collectSuggestions(page, selector);
    if (found.length) break;
  }
  const value0 = await input.inputValue().catch(() => '');
  if (!found.length) {
    return {
      ok: false,
      value: value0,
      suggestions: [],
      message:
        `No aparecieron sugerencias para "${text}". El campo contiene "${value0}". ` +
        'Si la web no usa lista desplegable, el valor ya está puesto; si la usa, prueba con menos texto o mira la página.',
    };
  }
  const names = found.map((f) => f.text);
  const pick = pickSuggestion(option ?? text, names);
  if (pick.kind === 'none') {
    return {
      ok: false,
      value: value0,
      suggestions: names,
      message: `Ninguna sugerencia coincide con "${option ?? text}". Opciones: ${names.map((n) => `"${n}"`).join(', ')}.`,
    };
  }
  if (pick.kind === 'ambiguous') {
    const shown = pick.indexes.map((i) => names[i]);
    return {
      ok: false,
      value: value0,
      suggestions: names,
      message:
        `Varias sugerencias coinciden con "${option ?? text}": ${shown.map((n) => `"${n}"`).join(', ')}. ` +
        'No elijo por ti: repite la acción con option igual al texto de la que quieras.',
    };
  }
  const chosen = names[pick.index] as string;
  try {
    await page.locator(`[${MARK}="${pick.index}"]`).first().click({ timeout: 4_000 });
  } catch {
    // A list that closes on blur or sits under an overlay: keyboard is the fallback.
    for (let i = 0; i <= pick.index; i++) await input.press('ArrowDown');
    await input.press('Enter');
  }
  await page.waitForTimeout(opts.settleMs ?? 400);
  const value = await input.inputValue().catch(() => '');
  if (!value.trim() || looksDuplicated(value, text)) {
    return {
      ok: false,
      value,
      suggestions: names,
      message: `ATENCIÓN: tras elegir "${chosen}" el campo quedó con "${value}". Límpialo y repite; no sigas con ese valor.`,
    };
  }
  // The field should now reflect the chosen suggestion, not only what was typed.
  const reflects =
    normalizeText(value).includes(normalizeText(chosen)) ||
    normalizeText(chosen).includes(normalizeText(value)) ||
    normalizeText(value) !== normalizeText(text);
  if (!reflects) {
    return {
      ok: false,
      value,
      suggestions: names,
      message: `ATENCIÓN: elegí "${chosen}" pero el campo sigue con "${value}" (lo que escribí). La selección no parece haberse aplicado.`,
    };
  }
  return {
    ok: true,
    value,
    suggestions: names,
    message: `Elegida "${chosen}"; el campo contiene "${value}".`,
  };
}
