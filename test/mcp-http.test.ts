import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/vault.js', () => ({
  vaultGet: vi.fn(async (key: string) =>
    key === 'mcp:remoto:token' ? 'tok-SECRETO-123' : undefined,
  ),
}));

import { log } from '../src/log.js';
import {
  checkMcpUrl,
  findSseResponse,
  McpHttpClient,
  mcpHttpEnabled,
  parseMcpHttpServers,
} from '../src/mcp/http-client.js';
import { createMcpTools } from '../src/mcp/tools.js';

type Handler = (body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => void;
const servers: Server[] = [];

async function fakeServer(handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => handler(JSON.parse(raw || '{}'), req, res));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

function json(res: ServerResponse, msg: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(msg));
}

/** Servidor MCP falso: guarda las cabeceras que recibe en cada método. */
function mcpHandler(
  seen: Array<{ method: string; headers: IncomingMessage['headers'] }>,
  sse = false,
): Handler {
  return (body, req, res) => {
    const method = String(body.method);
    seen.push({ method, headers: req.headers });
    if (body.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    let result: unknown = {};
    if (method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: {} };
    if (method === 'tools/list')
      result = { tools: [{ name: 'eco', description: 'Repite', inputSchema: { type: 'object' } }] };
    if (method === 'tools/call') {
      const args = (body.params as { arguments: { texto: string } }).arguments;
      result = { content: [{ type: 'text', text: `eco:${args.texto}` }] };
    }
    const msg = { jsonrpc: '2.0', id: body.id, result };
    const extra: Record<string, string> =
      method === 'initialize' ? { 'mcp-session-id': 'sesion-42' } : {};
    if (!sse) return json(res, msg, extra);
    res.writeHead(200, { 'content-type': 'text/event-stream', ...extra });
    res.end(
      `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: ${JSON.stringify(msg)}\n\n`,
    );
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe('MCP por HTTP: configuración', () => {
  it('apagado por defecto: solo PA_MCP_HTTP=1 lo enciende', () => {
    expect(mcpHttpEnabled({})).toBe(false);
    expect(mcpHttpEnabled({ PA_MCP_HTTP: '0' })).toBe(false);
    expect(mcpHttpEnabled({ PA_MCP_HTTP: '1' })).toBe(true);
  });

  it('solo https, o http hacia el propio equipo', () => {
    expect(checkMcpUrl('https://mcp.ejemplo.com/mcp')).not.toBeNull();
    expect(checkMcpUrl('http://127.0.0.1:8080/mcp')).not.toBeNull();
    expect(checkMcpUrl('http://localhost:8080/mcp')).not.toBeNull();
    expect(checkMcpUrl('http://[::1]:8080/mcp')).not.toBeNull();
    expect(checkMcpUrl('http://mcp.ejemplo.com/mcp')).toBeNull();
    expect(checkMcpUrl('http://192.168.1.5/mcp')).toBeNull();
    expect(checkMcpUrl('http://localhost.evil.com/mcp')).toBeNull();
    expect(checkMcpUrl('file:///etc/passwd')).toBeNull();
    expect(checkMcpUrl('https://user:pw@mcp.ejemplo.com/')).toBeNull();
    expect(checkMcpUrl('no es url')).toBeNull();
  });

  it('lee solo las entradas con url; descarta las de command, repetidas y URLs no permitidas', () => {
    const raw = JSON.stringify([
      { name: 'local', command: 'node', args: ['x.js'] },
      {
        name: 'remoto',
        url: 'https://mcp.ejemplo.com/mcp',
        allowedTools: ['eco'],
        timeoutMs: 5000,
      },
      { name: 'remoto', url: 'https://otro.com/mcp' },
      { name: 'lan', url: 'http://10.0.0.2/mcp' },
      { name: 'mal nombre', url: 'https://x.com/' },
    ]);
    expect(parseMcpHttpServers(raw)).toEqual([
      {
        name: 'remoto',
        url: 'https://mcp.ejemplo.com/mcp',
        allowedTools: ['eco'],
        timeoutMs: 5000,
      },
    ]);
    expect(parseMcpHttpServers('{no json')).toEqual([]);
  });

  it('SSE: encuentra la respuesta con el id pedido entre otros eventos', () => {
    const body =
      'data: {"jsonrpc":"2.0","method":"x"}\r\n\r\ndata: {"jsonrpc":"2.0","id":7,\ndata: "result":{"ok":1}}\n\n';
    expect(findSseResponse(body, 7)).toEqual({ jsonrpc: '2.0', id: 7, result: { ok: 1 } });
    expect(findSseResponse(body, 8)).toBeUndefined();
  });
});

describe('MCP por HTTP: cliente contra servidor falso', () => {
  it('initialize + tools/list + tools/call con JSON; reenvía Mcp-Session-Id y el token', async () => {
    const seen: Array<{ method: string; headers: IncomingMessage['headers'] }> = [];
    const url = await fakeServer(mcpHandler(seen));
    const client = new McpHttpClient({ name: 'remoto', url }, async () => 'tok-1');
    await client.start();
    expect(await client.listTools()).toEqual([
      { name: 'eco', description: 'Repite', inputSchema: { type: 'object' } },
    ]);
    expect(await client.callTool('eco', { texto: 'hola' })).toEqual({
      text: 'eco:hola',
      isError: false,
    });
    expect(seen.map((s) => s.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/call',
    ]);
    expect(seen[0]?.headers['mcp-session-id']).toBeUndefined();
    for (const s of seen.slice(1)) expect(s.headers['mcp-session-id']).toBe('sesion-42');
    for (const s of seen) expect(s.headers.authorization).toBe('Bearer tok-1');
    expect(seen[0]?.headers.accept).toContain('text/event-stream');
  });

  it('respuestas text/event-stream se interpretan igual', async () => {
    const seen: Array<{ method: string; headers: IncomingMessage['headers'] }> = [];
    const url = await fakeServer(mcpHandler(seen, true));
    const client = new McpHttpClient({ name: 'sse', url }, async () => undefined);
    await client.start();
    expect(await client.callTool('eco', { texto: 'x' })).toEqual({ text: 'eco:x', isError: false });
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it('no sigue redirecciones (el token no viaja a otro sitio)', async () => {
    const url = await fakeServer((_b, _q, res) => {
      res.writeHead(307, { location: 'https://otro.example/mcp' });
      res.end();
    });
    const client = new McpHttpClient({ name: 'r', url }, async () => 'tok');
    await expect(client.start()).rejects.toThrow(/redirigir/);
  });

  it('timeout por petición', async () => {
    const url = await fakeServer(() => {
      /* nunca responde */
    });
    const client = new McpHttpClient({ name: 'lento', url, timeoutMs: 150 }, async () => undefined);
    await expect(client.start()).rejects.toThrow(/Tiempo de espera agotado \(150 ms\)/);
  });
});

describe('MCP por HTTP: sesión caducada', () => {
  it('404 con sesión → nuevo initialize y la llamada se repite una vez', async () => {
    const seen: Array<{ method: string; headers: IncomingMessage['headers'] }> = [];
    const inner = mcpHandler(seen);
    let expireOnce = true;
    const url = await fakeServer((body, req, res) => {
      if (body.method === 'tools/call' && expireOnce) {
        expireOnce = false;
        seen.push({ method: 'tools/call(404)', headers: req.headers });
        res.writeHead(404);
        res.end();
        return;
      }
      inner(body, req, res);
    });
    const client = new McpHttpClient({ name: 'cad', url }, async () => undefined);
    await client.start();
    expect(await client.callTool('eco', { texto: 'otra' })).toEqual({
      text: 'eco:otra',
      isError: false,
    });
    expect(seen.map((s) => s.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call(404)',
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(seen[3]?.headers['mcp-session-id']).toBeUndefined();
  });

  it('404 repetido no entra en bucle: falla tras un reintento', async () => {
    let calls = 0;
    const inner = mcpHandler([]);
    const url = await fakeServer((body, req, res) => {
      if (body.method === 'tools/list') {
        calls += 1;
        res.writeHead(404);
        res.end();
        return;
      }
      inner(body, req, res);
    });
    const client = new McpHttpClient({ name: 'cad2', url }, async () => undefined);
    await client.start();
    await expect(client.listTools()).rejects.toThrow(/caducado/);
    expect(calls).toBe(2);
  });

  it('404 sin sesión es un error normal (sin reintento)', async () => {
    let posts = 0;
    const url = await fakeServer((_b, _q, res) => {
      posts += 1;
      res.writeHead(404);
      res.end();
    });
    const client = new McpHttpClient({ name: 'nada', url }, async () => undefined);
    await expect(client.start()).rejects.toThrow(/HTTP 404/);
    expect(posts).toBe(1);
  });
});

describe('MCP por HTTP: puente de tools', () => {
  it('publica las tools del servidor HTTP y la llamada funciona', async () => {
    const url = await fakeServer(mcpHandler([]));
    const tools = await createMcpTools([], [{ name: 'remoto', url }]);
    expect(tools.map((t) => t.name)).toEqual(['mcp_remoto_eco']);
    const out = await tools[0]?.execute('id1', { texto: 'hi' });
    expect(out?.content).toEqual([{ type: 'text', text: 'eco:hi' }]);
  });

  it('401: el servidor se omite con aviso, los demás siguen, y el token no sale en el log', async () => {
    const warn = vi.spyOn(log, 'warn');
    const denied = await fakeServer((_b, _q, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"no"}');
    });
    const ok = await fakeServer(mcpHandler([]));
    const tools = await createMcpTools(
      [],
      [
        { name: 'remoto', url: denied },
        { name: 'bueno', url: ok },
      ],
    );
    expect(tools.map((t) => t.name)).toEqual(['mcp_bueno_eco']);
    const omitted = warn.mock.calls.find((c) => c[0] === 'Servidor MCP omitido');
    expect(JSON.stringify(omitted)).toMatch(/HTTP 401/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('tok-SECRETO-123');
  });
});

describe('MCP por HTTP: cableado en cli.ts', () => {
  it('las entradas con url solo se usan con PA_MCP_HTTP=1', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(src).toMatch(
      /mcpHttpEnabled\(\)\s*\?\s*parseMcpHttpServers\(process\.env\.PA_MCP_SERVERS\)\s*:\s*\[\]/,
    );
    expect(src).toContain('createMcpTools(mcpServers, mcpHttpServers)');
  });
});
