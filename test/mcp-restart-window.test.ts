import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpClient } from '../src/mcp/client.js';

const DYING = fileURLToPath(new URL('./fixtures/mcp-dying-server.mjs', import.meta.url));
const clients: McpClient[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe('reinicios MCP en un daemon que dura días', () => {
  it('tras un rato estable vuelve a poder reiniciar el servidor', async () => {
    let now = Date.parse('2026-10-30T10:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const client = new McpClient({
      name: 'flaky',
      command: process.execPath,
      args: [DYING, '--die-always'],
      reconnect: true,
    });
    clients.push(client);
    await client.start();

    await expect(client.callTool('echo', { i: 1 })).rejects.toThrow();
    await expect(client.callTool('echo', { i: 2 })).rejects.toThrow();
    await expect(client.callTool('echo', { i: 3 })).rejects.toThrow();
    // Ráfaga seguida: el tope sigue protegiendo de un bucle de reinicios.
    await expect(client.callTool('echo', { i: 4 })).rejects.toThrow(/3 reinicios/i);

    // Un día después (caídas sueltas, no un bucle) el servidor se puede revivir otra vez.
    now += 24 * 60 * 60 * 1000;
    await expect(client.callTool('echo', { i: 5 })).rejects.not.toThrow(/3 reinicios/i);
  }, 30_000);
});
