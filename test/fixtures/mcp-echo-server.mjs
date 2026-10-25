#!/usr/bin/env node
/**
 * Servidor MCP de prueba: habla JSON-RPC por lineas sobre stdin/stdout.
 *
 * Tools:
 *  - echo: devuelve los argumentos recibidos como JSON.
 *  - boom: devuelve un resultado con isError.
 *
 * Flags:
 *  - --hang-tools: ignora tools/list y tools/call (para probar timeouts).
 *  - --exit-after-tools-list: termina justo despues de responder tools/list.
 *  - --exit-on-call: termina sin responder el primer tools/call.
 */
import { createInterface } from 'node:readline';

const hangTools = process.argv.includes('--hang-tools');
const exitAfterToolsList = process.argv.includes('--exit-after-tools-list');
const exitOnCall = process.argv.includes('--exit-on-call');

const tools = [
  {
    name: 'echo',
    description: 'Devuelve los argumentos recibidos como JSON.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      additionalProperties: true,
    },
  },
  {
    name: 'boom',
    description: 'Falla a proposito.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(message) {
  const { id, method, params } = message;
  const isRequest = typeof id === 'number' || typeof id === 'string';

  if (method === 'initialize' && isRequest) {
    reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mcp-echo-fixture', version: '1.0.0' },
    });
    return;
  }
  if (method === 'notifications/initialized') return;

  if (method === 'tools/list' && isRequest) {
    if (hangTools) return;
    reply(id, { tools });
    if (exitAfterToolsList) setTimeout(() => process.exit(0), 10);
    return;
  }

  if (method === 'tools/call' && isRequest) {
    if (hangTools) return;
    if (exitOnCall) {
      process.exit(0);
    }
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === 'echo') {
      const text = JSON.stringify(args);
      // Dos bloques de texto y uno de imagen: el cliente debe concatenar los
      // primeros e ignorar el ultimo.
      reply(id, {
        content: [
          { type: 'text', text: text.slice(0, 1) },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'text', text: text.slice(1) },
        ],
        isError: false,
      });
    } else if (name === 'boom') {
      reply(id, { content: [{ type: 'text', text: 'boom a proposito' }], isError: true });
    } else {
      reply(id, {
        content: [{ type: 'text', text: `herramienta desconocida: ${name}` }],
        isError: true,
      });
    }
    return;
  }

  if (isRequest) fail(id, -32601, `metodo desconocido: ${method}`);
}

// Aviso no JSON antes del protocolo: el cliente debe ignorarlo sin romperse.
process.stdout.write('mcp-echo-server: aviso no JSON que el cliente debe ignorar\n');

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message && typeof message === 'object' && !Array.isArray(message)) handle(message);
});
