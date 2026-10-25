import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { McpClient, type McpServerConfig, parseMcpServers } from '../src/mcp/client.js';
import { createMcpTools } from '../src/mcp/tools.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));
const DYING = fileURLToPath(new URL('./fixtures/mcp-dying-server.mjs', import.meta.url));
const clients: McpClient[] = [];
const dirs: string[] = [];

function clientFor(
  args: string[] = [],
  extra: Partial<McpServerConfig> = {},
  timeoutMs?: number,
): McpClient {
  const config: McpServerConfig = {
    name: 'echo',
    command: process.execPath,
    args: [FIXTURE, ...args],
    ...extra,
  };
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  const client = new McpClient(config);
  clients.push(client);
  return client;
}

function dyingClient(args: string[], extra: Partial<McpServerConfig> = {}): McpClient {
  const client = new McpClient({
    name: 'flaky',
    command: process.execPath,
    args: [DYING, ...args],
    ...extra,
  });
  clients.push(client);
  return client;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pa-mcp-extra-'));
  dirs.push(dir);
  return dir;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('recursos MCP', () => {
  it('lista recursos y lee su contenido de texto', async () => {
    const client = clientFor();
    await client.start();

    const recursos = await client.listResources();
    expect(recursos.map((recurso) => recurso.uri)).toEqual(['echo://saludo', 'echo://nota']);
    expect(recursos[0]).toMatchObject({
      uri: 'echo://saludo',
      name: 'Saludo',
      mimeType: 'text/plain',
    });

    const contenido = await client.readResource('echo://saludo');
    expect(contenido).toEqual([
      {
        uri: 'echo://saludo',
        mimeType: 'text/plain',
        text: 'hola desde el fixture',
      },
    ]);
  });

  it('lanza un error claro si el recurso no existe o falta la URI', async () => {
    const client = clientFor();
    await client.start();

    await expect(client.readResource('echo://no-existe')).rejects.toThrow(
      /resources\/read.*recurso desconocido/i,
    );
    await expect(client.readResource('   ')).rejects.toThrow(/falta la URI/i);
  });
});

describe('prompts MCP', () => {
  it('lista prompts y los resuelve con argumentos', async () => {
    const client = clientFor();
    await client.start();

    const prompts = await client.listPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      name: 'saludo',
      arguments: [{ name: 'nombre', required: true }],
    });

    const resuelto = await client.getPrompt('saludo', { nombre: 'Nico' });
    expect(resuelto.description).toContain('fixture');
    expect(resuelto.messages).toEqual([
      { role: 'user', content: { type: 'text', text: 'Hola, Nico.' } },
    ]);
  });

  it('lanza un error claro si el prompt no existe', async () => {
    const client = clientFor();
    await client.start();
    await expect(client.getPrompt('desconocido')).rejects.toThrow(
      /prompts\/get.*prompt desconocido/i,
    );
  });
});

describe('reconexion MCP', () => {
  it('start es idempotente, incluso en llamadas concurrentes', async () => {
    const client = clientFor();
    await Promise.all([client.start(), client.start()]);
    await expect(client.listTools()).resolves.toHaveLength(2);
  });

  it('ensureAlive reinicia un proceso que ya habia muerto', async () => {
    const client = clientFor(['--exit-after-tools-list']);
    await client.start();
    await client.listTools();
    await wait(200);

    await client.ensureAlive();
    const result = await client.callTool('echo', { tras: 'reinicio' });
    expect(result).toEqual({ text: JSON.stringify({ tras: 'reinicio' }), isError: false });
  });

  it('callTool reinicia y reintenta una vez si reconnect esta activo', async () => {
    const dir = tempDir();
    const marca = join(dir, 'muerto');
    const client = dyingClient([`--die-after=0`, `--once-file=${marca}`], { reconnect: true });
    await client.start();

    const result = await client.callTool('echo', { hola: 'mundo' });
    expect(result).toEqual({ text: JSON.stringify({ hola: 'mundo' }), isError: false });
    expect(existsSync(marca)).toBe(true);
  });

  it('sin reconnect no reintenta y la llamada falla', async () => {
    const client = dyingClient(['--die-after=0']);
    await client.start();
    await expect(client.callTool('echo', {})).rejects.toThrow(/MCP|termino|entrada/i);
  });

  it('deja de reiniciar despues de tres intentos', async () => {
    const client = dyingClient(['--die-always'], { reconnect: true });
    await client.start();

    await expect(client.callTool('echo', { intento: 1 })).rejects.toThrow();
    await expect(client.callTool('echo', { intento: 2 })).rejects.toThrow();
    await expect(client.callTool('echo', { intento: 3 })).rejects.toThrow();
    await expect(client.callTool('echo', { intento: 4 })).rejects.toThrow(/3 reinicios/i);
  });
});

describe('createMcpTools con filtros', () => {
  it('publica solo las tools de allowedTools', async () => {
    const tools = await createMcpTools([
      {
        name: 'echo',
        command: process.execPath,
        args: [FIXTURE, '--exit-after-tools-list'],
        allowedTools: ['boom'],
      },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(['mcp_echo_boom']);
  });

  it('una lista vacia no publica ninguna tool', async () => {
    const tools = await createMcpTools([
      {
        name: 'echo',
        command: process.execPath,
        args: [FIXTURE, '--exit-after-tools-list'],
        allowedTools: [],
      },
    ]);
    expect(tools).toEqual([]);
  });
});

describe('parseMcpServers con filtros', () => {
  it('conserva allowedTools y reconnect', () => {
    const raw = JSON.stringify([
      {
        name: 'filtrado',
        command: 'node',
        allowedTools: ['echo', ' boom ', 7],
        reconnect: true,
      },
    ]);
    expect(parseMcpServers(raw)).toEqual([
      {
        name: 'filtrado',
        command: 'node',
        allowedTools: ['echo', 'boom'],
        reconnect: true,
      },
    ]);
  });
});
