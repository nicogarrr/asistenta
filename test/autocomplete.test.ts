import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chooseSuggestion,
  looksDuplicated,
  normalizeText,
  pickSuggestion,
} from '../src/browser/autocomplete.js';

describe('pickSuggestion', () => {
  const opts = ['Madrid (TODAS)', 'Madrid-Chamartín-Clara Campoamor', 'Madrid-Puerta de Atocha'];

  it('is accent- and punctuation-insensitive', () => {
    expect(normalizeText('Madrid-Chamartín')).toBe('madrid chamartin');
  });

  it('takes a single match and prefers an exact one', () => {
    expect(pickSuggestion('madrid chamartin clara campoamor', opts)).toMatchObject({
      kind: 'one',
      index: 1,
    });
    expect(pickSuggestion('Madrid (TODAS)', opts)).toMatchObject({
      kind: 'one',
      index: 0,
      tier: 'exact',
    });
  });

  it('does not guess between equally good matches', () => {
    const r = pickSuggestion('Madrid', opts);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.indexes).toEqual([0, 1, 2]);
  });

  it('says none when nothing matches', () => {
    expect(pickSuggestion('Narnia', opts)).toEqual({ kind: 'none' });
    expect(pickSuggestion('', opts)).toEqual({ kind: 'none' });
  });
});

describe('looksDuplicated', () => {
  it('detects the repeated-text failure and nothing else', () => {
    expect(looksDuplicated('MadridMadrid', 'Madrid')).toBe(true);
    expect(looksDuplicated('Madrid Madrid', 'madrid')).toBe(true);
    expect(looksDuplicated('Madrid (TODAS)', 'Madrid')).toBe(false);
    expect(looksDuplicated('', 'Madrid')).toBe(false);
  });
});

// Three unrelated widgets, none of them knowing about the others: the point is that
// the same code works on all of them.
const ARIA = `<input id="a" role="combobox" aria-controls="lb" aria-expanded="false" autocomplete="off">
<ul id="lb" role="listbox" style="display:none"></ul>
<script>
const cities = ['Valencia Joaquín Sorolla', 'Valencia Cabanyal', 'Vigo Urzaiz'];
const a = document.getElementById('a'), lb = document.getElementById('lb');
a.addEventListener('input', () => {
  const q = a.value.toLowerCase();
  lb.innerHTML = '';
  const hits = cities.filter(c => q && c.toLowerCase().includes(q));
  hits.forEach(c => { const li = document.createElement('li'); li.setAttribute('role','option'); li.textContent = c;
    li.addEventListener('click', () => { a.value = c; lb.style.display = 'none'; }); lb.appendChild(li); });
  lb.style.display = hits.length ? 'block' : 'none';
});
</script>`;

const PLAIN = `<input id="b" autocomplete="off" style="display:block;margin-top:10px">
<div id="box" style="position:absolute;top:50px;left:8px;width:300px"></div>
<script>
const items = ['Oviedo', 'Ovar', 'Madrid-Chamartín'];
const b = document.getElementById('b'), box = document.getElementById('box');
b.addEventListener('input', () => {
  box.innerHTML = '';
  items.filter(i => b.value && i.toLowerCase().startsWith(b.value.toLowerCase())).forEach(i => {
    const d = document.createElement('div'); d.className = 'sug'; d.textContent = i; d.style.height = '20px';
    d.addEventListener('mousedown', () => { b.value = i; box.innerHTML = ''; }); box.appendChild(d); });
});
</script>`;

const BROKEN = `<input id="c" autocomplete="off">
<ul id="l" style="position:absolute;top:30px"></ul>
<script>
const c = document.getElementById('c'), l = document.getElementById('l');
c.addEventListener('input', () => {
  l.innerHTML = '<li id="o">Madrid Atocha</li>';
  document.getElementById('o').addEventListener('click', () => { c.value = c.value + c.value; l.innerHTML = ''; });
});
</script>`;

describe('chooseSuggestion on real pages', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  beforeEach(async () => {
    // A fresh page per test: setContent keeps the old global, so a second `const` of the
    // same name in the fixture script would throw and the widget would never wire up.
    page = await browser.newPage();
  });
  afterEach(async () => {
    await page.close();
  });
  afterAll(async () => {
    await browser.close();
  });
  const quick = { settleMs: 80, waitMs: 1500 };

  it('picks the suggestion of an ARIA combobox and verifies the field', async () => {
    await page.setContent(ARIA);
    const r = await chooseSuggestion(page, '#a', 'Valencia Joaquín', undefined, quick);
    expect(r.ok).toBe(true);
    expect(r.value).toBe('Valencia Joaquín Sorolla');
  });

  it('asks instead of guessing when several suggestions match, then accepts option', async () => {
    await page.setContent(ARIA);
    const amb = await chooseSuggestion(page, '#a', 'Valencia', undefined, quick);
    expect(amb.ok).toBe(false);
    expect(amb.message).toContain('Varias sugerencias');
    expect(amb.suggestions).toEqual(['Valencia Joaquín Sorolla', 'Valencia Cabanyal']);
    const r = await chooseSuggestion(page, '#a', 'Valencia', 'Valencia Cabanyal', quick);
    expect(r.ok).toBe(true);
    expect(r.value).toBe('Valencia Cabanyal');
  });

  it('finds an unlabelled dropdown by position, accents and all', async () => {
    await page.setContent(PLAIN);
    const r = await chooseSuggestion(page, '#b', 'Oviedo', undefined, quick);
    expect(r.ok).toBe(true);
    expect(r.value).toBe('Oviedo');
    await page.close();
    page = await browser.newPage();
    await page.setContent(PLAIN);
    const r2 = await chooseSuggestion(page, '#b', 'Madrid', 'Madrid Chamartin', quick);
    expect(r2.value).toBe('Madrid-Chamartín');
  });

  it('does not report success when the field ends up with an unrelated value', async () => {
    await page.setContent(`<input id="d" autocomplete="off">
<ul id="l" style="position:absolute;top:40px;margin:0"></ul>
<script>
const d = document.getElementById('d'), l = document.getElementById('l');
d.addEventListener('input', () => { l.innerHTML = '<li>Madrid-Atocha</li>'; });
l.addEventListener('mousedown', () => { d.value = 'Barcelona'; l.innerHTML = ''; });
</script>`);
    const r = await chooseSuggestion(page, '#d', 'Madrid', 'Madrid-Atocha', quick);
    expect(r.ok).toBe(false);
    expect(r.value).toBe('Barcelona');
    expect(r.message).toContain('esperaba "Madrid-Atocha"');
  });

  it('reports no suggestions instead of claiming a choice', async () => {
    await page.setContent(ARIA);
    const r = await chooseSuggestion(page, '#a', 'Narnia', undefined, quick);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('No aparecieron sugerencias');
    expect(r.value).toBe('Narnia');
  });

  it('flags a widget that leaves "MadridMadrid"', async () => {
    await page.setContent(BROKEN);
    const r = await chooseSuggestion(page, '#c', 'Madrid', undefined, quick);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('ATENCIÓN');
    expect(r.value).toBe('MadridMadrid');
  });

  it('replaces text already in the field instead of appending to it', async () => {
    await page.setContent(ARIA);
    await page.fill('#a', 'basura previa');
    const r = await chooseSuggestion(page, '#a', 'Vigo', undefined, quick);
    expect(r.value).toBe('Vigo Urzaiz');
  });
});

describe('pickSuggestion weak matches', () => {
  it('a lone substring hit is weak, not chosen', () => {
    expect(pickSuggestion('ana', ['Santana', 'Madrid'])).toEqual({ kind: 'weak', index: 0 });
  });
});
