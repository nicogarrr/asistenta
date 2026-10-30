import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, vi } from 'vitest';
import { BrowserService } from '../src/browser/service.js';
import { itBrowser } from './helpers/real-browser.js';

itBrowser(
  'strict close propagates browser context failure instead of certifying a clean shutdown',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'pa-strict-close-'));
    const server = createServer((_req, res) => res.end('<html><body>local fixture</body></html>'));
    const originals: Array<() => Promise<void>> = [];
    const launch = chromium.launchPersistentContext.bind(chromium);
    const spy = vi
      .spyOn(chromium, 'launchPersistentContext')
      .mockImplementation(async (...args) => {
        const context = await launch(...args);
        originals.push(context.close.bind(context));
        vi.spyOn(context, 'close').mockRejectedValue(new Error('fixture context close failed'));
        return context;
      });
    try {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const service = new BrowserService({
        profilesDir: root,
        policy: {
          autoApprove: true,
          allowPrivateHosts: true,
          adSkipIntervalMs: 0,
          approve: async () => true,
        },
      });
      await service.open('strict', `http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      await expect(service.closeAll(true)).rejects.toThrow('cierre del navegador');
    } finally {
      spy.mockRestore();
      for (const close of originals) await close();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
