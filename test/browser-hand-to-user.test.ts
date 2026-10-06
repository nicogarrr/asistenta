import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserService } from '../src/browser/service.js';

describe('browser: handToUser sin pantalla', () => {
  const root = mkdtempSync(join(tmpdir(), 'pa-hand-'));
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html><body><h1>hola</h1></body></html>');
  });
  const service = new BrowserService({
    policy: {
      autoApprove: true,
      allowPrivateHosts: true,
      adSkipIntervalMs: 0,
      approve: async () => true,
    },
    profilesDir: join(root, 'profiles'),
    timeoutMs: 15_000,
  });

  afterAll(async () => {
    await service.closeAll();
    server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('si la ventana visible no arranca, la conversacion no se queda sin navegador', async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const scope = 'hand#main';
    await service.open(scope, `http://127.0.0.1:${port}/`, { visible: false });
    const shown = await service.handToUser(scope);
    if (shown) return; // hay pantalla: nada que recuperar
    expect(service.isOpen(scope)).toBe(true);
    expect(service.isVisible(scope)).toBe(false);
  }, 60_000);
});
