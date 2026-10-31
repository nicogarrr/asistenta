#!/usr/bin/env node
/**
 * Servidor MCP falso con forma de REA (para test/mcp-*.test.ts). Nunca se
 * descarga ni se arranca el REA real en los tests.
 *
 * Tools con pistas MCP como las de REA; env_report devuelve los NOMBRES del entorno.
 */
import { createInterface } from 'node:readline';

const tools = [
  { name: 'analyze_app', description: 'Inspect an app.', annotations: { readOnlyHint: true } },
  { name: 'env_report', description: 'Report env names.', annotations: { readOnlyHint: true } },
  {
    name: 'record_evidence',
    description: 'Record evidence.',
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  { name: 'launch_app', description: 'Run the app.', annotations: { destructiveHint: true } },
  { name: 'bare_tool', description: 'No hints.' },
].map((t) => ({
  ...t,
  inputSchema: { type: 'object', properties: { target: { type: 'string' } } },
}));

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const text = (value) => ({ content: [{ type: 'text', text: value }] });

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    send({
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'rea-fake', version: '0' },
      },
    });
  } else if (msg.method === 'tools/list') {
    send({ id: msg.id, result: { tools } });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params ?? {};
    if (name === 'env_report')
      send({ id: msg.id, result: text(Object.keys(process.env).sort().join(',')) });
    else send({ id: msg.id, result: text(`${name}:${args.target ?? ''}`) });
  } else {
    send({ id: msg.id, error: { code: -32601, message: 'not found' } });
  }
});
