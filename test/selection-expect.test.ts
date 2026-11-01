import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BrowserService, textIncludes } from '../src/browser/service.js';
import { createBrowserTool } from '../src/tools/browser.js';
import { describeBrowser } from './helpers/real-browser.js';

// SYNTHETIC store picker: clicking a button sets "Tienda activa" to that store.
const PAGE = `<!doctype html><html><body><p id="act">Tienda activa: ninguna</p>
<div><b>TIENDA NORTE</b> <button id="s1" onclick="act.textContent='Tienda activa: NORTE, Ciudad A'">ELEGIR</button></div>
<div><b>TIENDA SUR</b> <button id="s2" onclick="act.textContent='Tienda activa: SUR, Ciudad B'">ELEGIR</button></div>
</body></html>`;

describeBrowser('declared selection expectation is enforced in code (SYNTHETIC)', () => {
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
    // autoApprove: the gate is bypassed, so only the tool-level check can stop this.
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

  it('textIncludes is accent/case insensitive and rejects empty', () => {
    expect(textIncludes('Plaza Mayor, GIJÓN', 'gijon')).toBe(true);
    expect(textIncludes('Mollet', 'Gijón')).toBe(false);
    expect(textIncludes('x', '  ')).toBe(false);
  });

  it('wrong state after selection locks the session, even under autoApprove', async () => {
    const tool = createBrowserTool(svc, () => 'w');
    await tool.execute('1', { action: 'open', url });
    const r = await tool.execute('2', { action: 'click', selector: '#s1', expect: 'Ciudad B' });
    expect(JSON.stringify(r.content)).toContain('SELECCION_NO_CORROBORADA');
    await expect(tool.execute('3', { action: 'click', selector: '#s2' })).rejects.toThrow(
      /SELECCION_NO_CORROBORADA/,
    );
    await expect(tool.execute('4', { action: 'fill', selector: '#s1', text: 'x' })).rejects.toThrow(
      /SELECCION_NO_CORROBORADA/,
    );
    await tool.execute('5', { action: 'open', url }); // reset allowed
    const ok = await tool.execute('6', { action: 'click', selector: '#s2' });
    expect(JSON.stringify(ok.content)).not.toContain('NO_CORROBORADA');
  });

  it('consistent state is corroborated and does not lock', async () => {
    const tool = createBrowserTool(svc, () => 'p');
    await tool.execute('1', { action: 'open', url });
    const r = await tool.execute('2', { action: 'click', selector: '#s2', expect: 'Ciudad B' });
    expect(JSON.stringify(r.content)).toContain('SELECCION_CORROBORADA');
    const again = await tool.execute('3', { action: 'click', selector: '#s1' });
    expect(JSON.stringify(again.content)).not.toContain('NO_CORROBORADA');
  });
});
