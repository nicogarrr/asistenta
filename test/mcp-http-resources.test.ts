import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { McpHttpClient } from '../src/mcp/http-client.js';

// MCP por HTTP: además de tools, recursos (resources/list, resources/read) y prompts
// (prompts/list, prompts/get), con la misma forma que el cliente stdio. Servidor falso
// en 127.0.0.1; nunca se conecta a nada real.
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

type Seen = Array<{ method: string; params: unknown; auth?: string }>;

async function fakeMcp(seen: Seen, results: Record<string, unknown>, sse = false): Promise<string> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { id?: number; method: string; params?: unknown };
      seen.push({ method: body.method, params: body.params, auth: req.headers.authorization });
      if (body.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      const result =
        body.method === 'initialize' ? { protocolVersion: '2025-03-26' } : results[body.method];
      const msg = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
      if (sse && body.method !== 'initialize') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`event: message\ndata: ${msg}\n\n`);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(msg);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

const RESULTS = {
  'resources/list': {
    resources: [
      { uri: 'file:///notas/hoy.md', name: 'hoy', mimeType: 'text/markdown' },
      { uri: '' },
      'basura',
    ],
  },
  'resources/read': {
    contents: [
      { uri: 'file:///notas/hoy.md', mimeType: 'text/markdown', text: '# Hoy' },
      { uri: 'file:///notas/hoy.md' },
    ],
  },
  'prompts/list': {
    prompts: [
      {
        name: 'resumen',
        description: 'Resume',
        arguments: [{ name: 'tema', required: true }, { nope: 1 }],
      },
      { name: '' },
    ],
  },
  'prompts/get': {
    description: 'Resumen',
    messages: [{ role: 'user', content: { type: 'text', text: 'Resume X' } }, { role: 1 }],
  },
};

interface ResourcesAndPrompts {
  start(): Promise<void>;
  listResources?(): Promise<unknown>;
  readResource?(uri: string): Promise<unknown>;
  listPrompts?(): Promise<unknown>;
  getPrompt?(name: string, args?: Record<string, string>): Promise<unknown>;
}

// Antes de este cambio el cliente HTTP no tenía estos métodos: `?.` hace que el test
// falle con un error de aserción en vez de un TypeError.
const client = (url: string): Required<ResourcesAndPrompts> =>
  new McpHttpClient({ name: 'remoto', url }, async (k) =>
    k === 'mcp:remoto:token' ? 'tok-1' : undefined,
  ) as unknown as Required<ResourcesAndPrompts>;

describe('MCP por HTTP: recursos y prompts', () => {
  for (const sse of [false, true]) {
    it(`lista y lee recursos, lista y obtiene prompts (${sse ? 'SSE' : 'JSON'})`, async () => {
      const seen: Seen = [];
      const c = client(await fakeMcp(seen, RESULTS, sse));
      expect(typeof c.listResources).toBe('function');
      await c.start();
      expect(await c.listResources()).toEqual([
        { uri: 'file:///notas/hoy.md', name: 'hoy', mimeType: 'text/markdown' },
      ]);
      expect(await c.readResource('  file:///notas/hoy.md ')).toEqual([
        { uri: 'file:///notas/hoy.md', mimeType: 'text/markdown', text: '# Hoy' },
      ]);
      expect(await c.listPrompts()).toEqual([
        { name: 'resumen', description: 'Resume', arguments: [{ name: 'tema', required: true }] },
      ]);
      expect(await c.getPrompt('resumen', { tema: 'X' })).toEqual({
        description: 'Resumen',
        messages: [{ role: 'user', content: { type: 'text', text: 'Resume X' } }],
      });
      const byMethod = Object.fromEntries(seen.map((s) => [s.method, s]));
      expect(byMethod['resources/read']?.params).toEqual({ uri: 'file:///notas/hoy.md' });
      expect(byMethod['prompts/get']?.params).toEqual({
        name: 'resumen',
        arguments: { tema: 'X' },
      });
      // El token viaja en cada petición, como en tools.
      expect(byMethod['resources/list']?.auth).toBe('Bearer tok-1');
      expect(byMethod['prompts/get']?.auth).toBe('Bearer tok-1');
    });
  }

  it('respuestas inválidas: error claro en español, sin pedir nada si falta la URI o el nombre', async () => {
    const seen: Seen = [];
    const c = client(await fakeMcp(seen, { 'resources/list': {}, 'prompts/list': { prompts: 3 } }));
    await c.start();
    await expect(c.listResources()).rejects.toThrow(/lista de recursos invalida/);
    await expect(c.listPrompts()).rejects.toThrow(/lista de prompts invalida/);
    await expect(c.readResource('  ')).rejects.toThrow(/falta la URI/);
    await expect(c.getPrompt(' ')).rejects.toThrow(/falta el nombre/);
    expect(seen.map((s) => s.method)).not.toContain('resources/read');
    expect(seen.map((s) => s.method)).not.toContain('prompts/get');
  });

  it('un recurso sin contenido legible es un error', async () => {
    const c = client(await fakeMcp([], { 'resources/read': { contents: [{ uri: 'x://a' }] } }));
    await c.start();
    await expect(c.readResource('x://a')).rejects.toThrow(/no devolvio contenido legible/);
  });
});
