import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Ningún test lanza un navegador real por defecto: los que abren Chromium
// (Playwright directo o BrowserService sin simular) van detrás de
// PA_TEST_REAL_BROWSER=1 con describeBrowser / itBrowser (test/helpers/real-browser.ts).
// CI lo activa.
const dir = import.meta.dirname;
// Crean BrowserService pero simulan el lanzamiento o rechazan antes de abrir nada.
const noLaunch = new Set([
  'browser-ssrf.test.ts',
  'browser-popups-closed.test.ts',
  'browser-session-launch.test.ts',
  'real-browser-gate.test.ts',
]);
const opensBrowser = /\b(?:chromium|firefox|webkit)\.launch|new BrowserService\(/;
const gated = /^(?:describeBrowser|itBrowser)\(/m;

describe('pruebas con navegador real', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts') && !noLaunch.has(f));
  const launching = files.filter((f) => opensBrowser.test(readFileSync(join(dir, f), 'utf8')));

  it('el filtro encuentra las pruebas que abren un navegador', () => {
    expect(launching.length).toBeGreaterThan(5);
  });

  it('todas van detrás de PA_TEST_REAL_BROWSER (describeBrowser / itBrowser)', () => {
    const ungated = launching.filter((f) => {
      const src = readFileSync(join(dir, f), 'utf8');
      return !src.includes("from './helpers/real-browser.js'") || !gated.test(src);
    });
    expect(ungated).toEqual([]);
  });

  it('realBrowser solo es verdadero con PA_TEST_REAL_BROWSER=1', async () => {
    const { realBrowser } = await import('./helpers/real-browser.js');
    expect(realBrowser).toBe(process.env.PA_TEST_REAL_BROWSER === '1');
  });
});
