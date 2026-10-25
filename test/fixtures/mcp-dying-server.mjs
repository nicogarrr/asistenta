#!/usr/bin/env node
/**
 * Servidor MCP de prueba que se cae tras N llamadas.
 *
 * Habla JSON-RPC por lineas y solo anuncia la tool `echo`.
 *
 * Flags:
 *  - --die-after=N: muere al recibir la llamada N+1, despues de servir N
 *    (por defecto N=1). Muere sin responder, como un proceso que se cuelga.
 *  - --once-file=RUTA: deja una marca al morir; si la marca ya existe al
 *    arrancar, el servidor funciona con normalidad. Sirve para probar que el
 *    proceso reiniciado es uno nuevo y ya sano.
 *  - --die-always: muere en todas las llamadas, para agotar los reinicios.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

function flagValue(name) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
}

const dieAfterRaw = Number(flagValue('die-after') ?? '1');
const dieAfter = Number.isInteger(dieAfterRaw) && dieAfterRaw >= 0 ? dieAfterRaw : 1;
const onceFile = flagValue('once-file');
const dieAlways = process.argv.includes('--die-always');
const armed = dieAlways || !(onceFile && existsSync(onceFile));
let served = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function die() {
  if (onceFile) {
    try {
      writeFileSync(onceFile, String(process.pid));
    } catch {
      // La marca es una ayuda para el test; si no se puede escribir, igual morimos.
    }
  }
  process.exit(0);
}

function handle(message) {
  const { id, method, params } = message;
  const isRequest = typeof id === 'number' || typeof id === 'string';

  if (method === 'initialize' && isRequest) {
    reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'mcp-dying-fixture', version: '1.0.0' },
    });
    return;
  }
  if (method === 'notifications/initialized') return;

  if (method === 'tools/list' && isRequest) {
    reply(id, {
      tools: [
        {
          name: 'echo',
          description: 'Devuelve los argumentos recibidos como JSON.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: true },
        },
      ],
    });
    return;
  }

  if (method === 'tools/call' && isRequest) {
    if (armed && (dieAlways || served >= dieAfter)) die();
    served += 1;
    reply(id, {
      content: [{ type: 'text', text: JSON.stringify(params?.arguments ?? {}) }],
      isError: false,
    });
    return;
  }

  if (isRequest) fail(id, -32601, `metodo desconocido: ${method}`);
}

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
