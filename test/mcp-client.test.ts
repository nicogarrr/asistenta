import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { McpClient, type McpServerConfig, parseMcpServers } from '../src/mcp/client.js';
import { createMcpTools, mcpToolName } from '../src/mcp/tools.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));
const clients: McpClient[] = [];

function clientFor(extra: string[] = [], timeoutMs?: number): McpClient {
  const config: McpServerConfig = {
    name: 'echo',
    command: process.execPath,
    args: [FIXTURE, ...extra],
  };
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  const client = new McpClient(config);
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

describe('parseMcpServers', () => {
  it('acepta un array valido y conserva los campos opcionales', () => {
    const raw = JSON.stringify([
      {
        name: 'echo-server',
        command: 'node',
        args: ['servidor.js'],
        env: { TOKEN: 'x' },
        timeoutMs: 5000,
      },
    ]);
    expect(parseMcpServers(raw)).toEqual([
      {
        name: 'echo-server',
        command: 'node',
        args: ['servidor.js'],
        env: { TOKEN: 'x' },
        timeoutMs: 5000,
      },
    ]);
  });

  it('devuelve [] con JSON invalido o que no es un array', () => {
    expect(parseMcpServers(undefined)).toEqual([]);
    expect(parseMcpServers('')).toEqual([]);
    expect(parseMcpServers('{oops')).toEqual([]);
    expect(parseMcpServers('{"name":"echo"}')).toEqual([]);
  });

  it('descarta entradas sin nombre, sin comando o con nombre no saneado', () => {
    const raw = JSON.stringify([
      { name: '', command: 'node' },
      { name: 'ok', command: '' },
      { name: 'con espacio', command: 'node' },
      { name: 'bien', command: 'node' },
    ]);
    expect(parseMcpServers(raw)).toEqual([{ name: 'bien', command: 'node' }]);
  });

  it('deduplica por nombre y se queda con la primera aparicion', () => {
    const raw = JSON.stringify([
      { name: 'dup', command: 'uno' },
      { name: 'dup', command: 'dos' },
    ]);
    expect(parseMcpServers(raw)).toEqual([{ name: 'dup', command: 'uno' }]);
  });
});

describe('McpClient', () => {
  it('hace el handshake, lista tools y llama a echo', async () => {
    const client = clientFor();
    await client.start();

    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'boom']);
    expect(tools[0]?.description).toContain('Devuelve');
    expect(tools[0]?.inputSchema).toMatchObject({ type: 'object' });

    const result = await client.callTool('echo', { hola: 'mundo' });
    expect(result).toEqual({ text: JSON.stringify({ hola: 'mundo' }), isError: false });
  });

  it('marca isError cuando la tool remota falla', async () => {
    const client = clientFor();
    await client.start();
    const result = await client.callTool('boom', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('boom');
  });

  it('rechaza start si el ejecutable no existe', async () => {
    const client = new McpClient({
      name: 'fantasma',
      command: 'pa-mcp-no-existe-xyz',
    });
    clients.push(client);
    await expect(client.start()).rejects.toThrow(/No se pudo arrancar/);
  });

  it('rechaza por timeout cuando el servidor no responde', async () => {
    const client = clientFor(['--hang-tools'], 200);
    await client.start();
    await expect(client.callTool('echo', {})).rejects.toThrow(/Tiempo de espera agotado/);
  });

  it('rechaza la peticion pendiente si el proceso muere', async () => {
    const client = clientFor(['--exit-on-call']);
    await client.start();
    await expect(client.callTool('echo', {})).rejects.toThrow(/MCP|entrada/i);
  });
});

describe('createMcpTools', () => {
  it('sanea el nombre y lo recorta a 64 caracteres', () => {
    expect(mcpToolName('My Server!', 'Do Thing')).toBe('mcp_my_server__do_thing');
    expect(mcpToolName('a'.repeat(80), 'b'.repeat(80))).toHaveLength(64);
  });

  it('expone las tools del servidor con el contrato de AgentTool', async () => {
    const tools = await createMcpTools([
      {
        name: 'echo',
        command: process.execPath,
        args: [FIXTURE, '--exit-after-tools-list'],
      },
    ]);
    const echo = tools.find((tool) => tool.name === 'mcp_echo_echo');
    expect(echo).toBeDefined();
    expect(echo?.label).toBe('MCP echo');
    expect(echo?.description).toContain('Devuelve');
    expect(echo?.description).toContain('MCP externo');
    expect(echo?.executionMode).toBe('parallel');
    expect(echo?.parameters).toMatchObject({ type: 'object' });
  });

  it('se salta un servidor que no arranca y conserva los demas', async () => {
    const tools = await createMcpTools([
      { name: 'roto', command: 'pa-mcp-no-existe-xyz' },
      {
        name: 'echo',
        command: process.execPath,
        args: [FIXTURE, '--exit-after-tools-list'],
      },
    ]);
    expect(tools).toHaveLength(2);
    expect(tools.every((tool) => tool.name.startsWith('mcp_echo_'))).toBe(true);
  });

  it('convierte un fallo de llamada en un resultado con isError', async () => {
    const tools = await createMcpTools([
      {
        name: 'echo',
        command: process.execPath,
        args: [FIXTURE, '--exit-on-call'],
      },
    ]);
    const echo = tools.find((tool) => tool.name === 'mcp_echo_echo');
    if (!echo) throw new Error('falta la tool echo');
    const result = await echo.execute('llamada-1', {});
    expect(result.isError).toBe(true);
    const text = result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(text).toContain('Error');
  });
});
