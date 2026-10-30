import { chromium } from 'playwright';
import { expect } from 'vitest';
import { AD_ARGS } from '../src/browser/ads.js';
import { callPageAdClick, callPageMediaState, installPageScan } from '../src/browser/inpage.js';
import { itBrowser } from './helpers/real-browser.js';

itBrowser(
  'skip uses accessible label even when visible text is a countdown, fixed controls are visible and disabled ones are not clicks',
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<main class="ad-showing"><button class="ytp-ad-skip-button" style="position:fixed;bottom:20px" aria-label="Saltar anuncio" onclick="window.hit=(window.hit||0)+1">5</button><button class="ytp-ad-skip-button" disabled onclick="window.bad=true">Saltar anuncio</button></main>`,
      );
      await installPageScan(page);
      const before = await callPageMediaState<typeof AD_ARGS, { skipButtonsVisible: number }>(
        page,
        AD_ARGS,
      );
      expect(before.skipButtonsVisible).toBe(1);
      const result = await callPageAdClick<typeof AD_ARGS, { clicked: number }>(page, AD_ARGS);
      expect(result.clicked).toBe(1);
      expect(await page.evaluate(() => (window as unknown as { hit: number }).hit)).toBe(1);
      expect(
        await page.evaluate(() => (window as unknown as { bad?: boolean }).bad),
      ).toBeUndefined();
    } finally {
      await browser.close();
    }
  },
);
