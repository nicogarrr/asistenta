import { type Browser, chromium } from 'playwright';
import { hostOf, isBlockedPage, STORES } from './pricewatch.js';

const publicHosts = new Set([
  ...STORES.amazon.hosts,
  ...STORES.mediamarkt.hosts,
  ...STORES.pccomponentes.hosts,
]);
export function usesPublicBrowser(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:' && publicHosts.has(hostOf(url).replace(/^www\./, ''));
  } catch {
    return false;
  }
}

/** Fresh public browser per cycle. No cookies, stealth, challenge solver or login. */
export class PublicPriceBrowser {
  private browser: Browser | null = null;
  private pendingPermit: Promise<void> = Promise.resolve();
  private readonly launch: () => Promise<Browser>;
  constructor(launch: () => Promise<Browser> = () => chromium.launch({ headless: true })) {
    this.launch = launch;
  }
  async read(
    url: string,
    permit: (url: string) => Promise<boolean>,
  ): Promise<{ status: number; html: string }> {
    if (!usesPublicBrowser(url)) return { status: 403, html: '' };
    this.browser ??= await this.launch();
    const context = await this.browser.newContext({ serviceWorkers: 'block' });
    let denied = false;
    let challenge = false;
    try {
      await context.route('**/*', async (route) => {
        const request = route.request();
        const allowedType = ['document', 'script', 'xhr', 'fetch'].includes(request.resourceType());
        if (!allowedType || !usesPublicBrowser(request.url())) {
          await route.abort();
          return;
        }
        const check = this.pendingPermit.then(() => permit(request.url()));
        this.pendingPermit = check.then(
          () => undefined,
          () => undefined,
        );
        if (denied || challenge || !(await check)) {
          denied = true;
          await route.abort();
          return;
        }
        try {
          const response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
          const body = await response.text();
          if (isBlockedPage(response.status(), body)) {
            challenge = true;
            await route.abort();
            return;
          }
          await route.fulfill({ response, body });
        } catch {
          denied = true;
          await route.abort();
        }
      });
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      // Public JS may populate the listing. Never interact with a challenge.
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
      const html = await page.content();
      if (challenge || denied || isBlockedPage(response?.status() ?? 0, html))
        return { status: 403, html: '' };
      return { status: response?.status() ?? 0, html };
    } catch {
      return { status: challenge || denied ? 403 : 0, html: '' };
    } finally {
      await context.close();
    }
  }
  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    await browser?.close();
  }
}
