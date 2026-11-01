import { afterEach, describe, expect, it } from 'vitest';
import { McpClient, mcpStartFailureText } from '../src/mcp/client.js';

// robustez-7: el arranque fallido de un servidor MCP no debe llevar el error
// crudo del sistema (spawn … ENOENT) al modelo ni al chat; solo al log.
const clients: McpClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
});

describe('MCP: arranque fallido en castellano llano', () => {
  it('programa que no existe → dice cuál y qué hacer, sin ENOENT', async () => {
    const client = new McpClient({ name: 'fantasma', command: 'pa-mcp-no-existe-xyz' });
    clients.push(client);
    const err = await client.start().then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain('no encuentro el programa «pa-mcp-no-existe-xyz»');
    expect(err?.message).not.toMatch(/ENOENT|spawn/);
  });

  it('sin permiso y otros fallos: línea clara sin el texto crudo', () => {
    const eacces = Object.assign(new Error('spawn /x/y EACCES'), { code: 'EACCES' });
    expect(mcpStartFailureText('srv', '/x/y --a', eacces)).toBe(
      'No se pudo arrancar el servidor MCP "srv": no hay permiso para ejecutar «/x/y».',
    );
    const other = Object.assign(new Error('raro E2BIG'), { code: 'E2BIG' });
    const text = mcpStartFailureText('srv', 'npx algo', other);
    expect(text).toContain('Revisa su configuración');
    expect(text).not.toContain('E2BIG');
  });
});
