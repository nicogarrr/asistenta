/**
 * Puente entre las herramientas de un servidor MCP y el bucle del agente.
 *
 * Cada tool remota se publica como una AgentTool. Los clientes se arrancan al
 * construir el conjunto y no se cierran aqui: viven lo que el proceso, porque
 * el daemon no descarga servidores MCP en caliente. Si un servidor falla, se
 * registra el aviso y se omiten sus tools; los demas siguen funcionando.
 *
 * `allowedTools` actua de puerta: si esta definido, solo se publican las tools
 * nombradas. Con `reconnect`, el cliente revive el proceso caido y reintenta la
 * llamada una vez.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { log } from '../log.js';
import { McpClient, type McpServerConfig, type McpToolInfo } from './client.js';

const TOOL_NAME_MAX = 64;

/**
 * Clientes que deben seguir vivos aunque un servidor no haya anunciado tools.
 * No se exporta un `closeAll()`: el proceso entero termina con ellos.
 */
const liveClients: McpClient[] = [];

/**
 * Convierte el par servidor/tool en un nombre valido para el proveedor:
 * minusculas, todo lo que no sea `[a-z0-9_]` pasa a `_` y se recorta a 64.
 */
export function mcpToolName(server: string, tool: string): string {
  return `mcp_${server}_${tool}`
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .slice(0, TOOL_NAME_MAX);
}

/**
 * Arranca cada servidor y devuelve una AgentTool por cada tool anunciada.
 *
 * Un servidor que no arranca o no responde se salta con un aviso; su fallo no
 * impide usar los demas. Los clientes quedan vivos hasta que termine el
 * proceso: no hay `closeAll()` porque no se recargan en caliente.
 */
export async function createMcpTools(servers: McpServerConfig[]): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  for (const server of servers) {
    const client = new McpClient(server);
    try {
      await client.start();
      const remoteTools = await client.listTools();
      liveClients.push(client);
      const allowed = server.allowedTools;
      const selected =
        allowed === undefined
          ? remoteTools
          : remoteTools.filter((remote) => allowed.includes(remote.name));
      for (const remote of selected) {
        tools.push(createAgentTool(server, remote, client));
      }
    } catch (error) {
      client.close();
      log.warn('Servidor MCP omitido', {
        server: server.name,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return tools;
}

function createAgentTool(
  server: McpServerConfig,
  remote: McpToolInfo,
  client: McpClient,
): AgentTool {
  const description = remote.description?.trim();
  return {
    name: mcpToolName(server.name, remote.name),
    label: `MCP ${server.name}`,
    description: `${description || `Herramienta ${remote.name} del servidor MCP ${server.name}.`} (MCP externo)`,
    parameters: Type.Unsafe<Record<string, unknown>>(
      (remote.inputSchema as object | undefined) ?? { type: 'object', properties: {} },
    ),
    executionMode: 'parallel',
    execute: async (_toolCallId, args) => {
      try {
        const callArgs =
          typeof args === 'object' && args !== null && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};
        const result = await client.callTool(remote.name, callArgs);
        return {
          content: [{ type: 'text', text: result.text }],
          details: {},
          isError: result.isError,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: 'text',
              text: `Error al llamar a la herramienta MCP "${remote.name}" de "${server.name}": ${message}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  };
}
