import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatApproval } from '../src/approval-text.js';
import { BrowserService } from '../src/browser/service.js';
import { CONTEXT_MARK, createBrowserTool } from '../src/tools/browser.js';

// SYNTHETIC store list. Two identical buttons; only the card around each says which store it is.
const PAGE = `<!doctype html><html><body>
<div class="card"><b>TIENDA NORTE (#1)</b><p>Calle Uno 5, Ciudad A</p><button id="s1">ELEGIR TIENDA</button></div>
<div class="card"><b>TIENDA SUR (#2)</b><p>Calle Dos 9, Ciudad B</p><button id="s2">ELEGIR TIENDA</button></div>
</body></html>`;

describe('gate sees the card a selection button belongs to', () => {
  let server: Server;
  let svc: BrowserService;
  beforeAll(async () => {
    server = createServer((_q, r) => {
      r.setHeader('content-type', 'text/html; charset=utf-8');
      r.end(PAGE);
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    svc = new BrowserService({
      policy: { allowPrivateHosts: true, autoApprove: true, approve: async () => true },
      channel: 'chromium',
      timeoutMs: 15_000,
    });
    await svc.open('t', `http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  }, 60_000);
  afterAll(async () => {
    await svc.closeAll();
    server.close();
  });

  it('describeContext returns the right card for each identical button', async () => {
    expect(await svc.describeContext('t', '#s1')).toContain('Ciudad A');
    expect(await svc.describeContext('t', '#s2')).toContain('Ciudad B');
    expect(await svc.describeContext('t', '#s2')).not.toContain('Ciudad A');
  });

  it('gateHint carries it and the approval question shows it', async () => {
    const tool = createBrowserTool(svc, () => 't');
    const hint = await tool.gateHint({ action: 'click', selector: '#s2' });
    expect(hint).toContain(CONTEXT_MARK);
    const q = formatApproval(
      { tool: 'browser', args: { action: 'click', selector: '#s2', _target: hint }, actor: 'a' },
      'x',
    ).question;
    expect(q).toContain('Parte de:');
    expect(q).toContain('TIENDA SUR');
  });

  it('a page with no surrounding card adds nothing', async () => {
    expect(await svc.describeContext('t', 'Elemento inexistente')).toBe('');
  });
});
