import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserService } from '../src/browser/service.js';
import { UNREADABLE_TARGET } from '../src/browser/target.js';

// SYNTHETIC page. The model often names an element by the text it reads on screen
// ("Añadir a la cesta"), not by a CSS selector. The action resolves that text through the
// rescue chain; the gate hint has to describe the same element instead of "[destino ilegible]".
const PAGE = `<!doctype html><html><body>
<button id="a1">Añadir a la cesta</button>
<form action="/pedido"><p>Total: 25,00 €</p><button type="submit">Confirmar y pagar</button></form>
</body></html>`;

describe('describeTarget by visible text', () => {
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
    await svc.open('t', url);
  }, 60_000);
  afterAll(async () => {
    await svc.closeAll();
    server.close();
  });

  it('a text name resolves to the real element, not unreadable', async () => {
    const hint = await svc.describeTarget('t', 'Añadir a la cesta');
    expect(hint).not.toBe(UNREADABLE_TARGET);
    expect(hint).toContain('Añadir a la cesta');
  });

  it('a text name for the submit inside an amount form carries the amount marker', async () => {
    const hint = await svc.describeTarget('t', 'Confirmar y pagar');
    expect(hint).toContain('[importe en el formulario]');
  });

  it('a name that matches nothing stays unreadable (fails closed)', async () => {
    expect(await svc.describeTarget('t', 'Elemento que no existe en la página')).toBe(
      UNREADABLE_TARGET,
    );
  });

  it('a CSS selector still works as before', async () => {
    expect(await svc.describeTarget('t', '#a1')).toContain('Añadir a la cesta');
  });
});
