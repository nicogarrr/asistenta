import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserService } from '../src/browser/service.js';
import { createBrowserTool } from '../src/tools/browser.js';

// SYNTHETIC page. EXPERIMENTAL data returned to the model after a click: it must not
// claim the click had no effect, must not suggest retrying, and must not attribute causes.
const PAGE = `<!doctype html><html><body><div id="o">overlay abierto</div><p id="t"></p>
<button id="fast" onclick="t.textContent='linea nueva rapida'">RAPIDO</button>
<button id="slow" onclick="setTimeout(()=>{t.textContent='linea lenta'},2000)">LENTO</button>
<button id="rm" onclick="o.remove()">CERRAR</button></body></html>`;

describe('post-click visible-lines data keeps honest wording (SYNTHETIC, experimental)', () => {
  let server: Server;
  let svc: BrowserService;
  let url = '';
  beforeAll(async () => {
    server = createServer((_q, r) => {
      r.setHeader('content-type', 'text/html; charset=utf-8');
      r.end(PAGE);
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    svc = new BrowserService({
      policy: { allowPrivateHosts: true, autoApprove: true, approve: async () => true },
      channel: 'chromium',
      timeoutMs: 15_000,
    });
  }, 60_000);
  afterAll(async () => {
    await svc.closeAll();
    server.close();
  });
  const click = async (sel: string) => {
    const tool = createBrowserTool(svc, () => 'v');
    await tool.execute('1', { action: 'open', url } as never);
    const r = await tool.execute('2', { action: 'click', selector: sel } as never);
    return JSON.stringify(r.content);
  };

  it('new line: shown as observed, causality explicitly unknown', async () => {
    const t = await click('#fast');
    expect(t).toContain('linea nueva rapida');
    expect(t).toContain('no se sabe si las causo el clic');
    expect(t).toContain('NO confiable');
  });
  it('slow effect and removal-only read as "no new lines" WITHOUT claiming no effect or inviting a retry', async () => {
    for (const sel of ['#slow', '#rm']) {
      const t = await click(sel);
      expect(t).toContain('No se observaron lineas nuevas');
      expect(t).toContain('NO indica que el clic no tuviera efecto');
      expect(t).toContain('no repitas el clic');
      expect(t).not.toMatch(/ningun efecto|sin efecto|reintent/i);
    }
  });
});
