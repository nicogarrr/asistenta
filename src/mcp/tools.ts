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
import {
  McpClient,
  type McpPromptInfo,
  type McpPromptResult,
  type McpResourceContent,
  type McpResourceInfo,
  type McpServerConfig,
  type McpToolCallResult,
  type McpToolInfo,
} from './client.js';
import { McpHttpClient, type McpHttpServerConfig } from './http-client.js';

/** Lo que el puente necesita de un cliente MCP, sea stdio o HTTP. */
interface McpToolClient {
  start(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<McpToolCallResult>;
  close(): void;
  listResources(): Promise<McpResourceInfo[]>;
  readResource(uri: string): Promise<McpResourceContent[]>;
  listPrompts(): Promise<McpPromptInfo[]>;
  getPrompt(name: string, args?: Record<string, string>): Promise<McpPromptResult>;
}

/** Opciones del puente. */
export interface McpToolsOptions {
  /**
   * Publica, por servidor, dos herramientas de solo lectura para sus recursos y
   * prompts. Apagado por defecto: solo con PA_MCP_RESOURCES=1.
   */
  resources?: boolean;
}

/** PA_MCP_RESOURCES=1 activa recursos y prompts MCP; cualquier otro valor los deja apagados. */
export function mcpResourcesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PA_MCP_RESOURCES ?? '').trim() === '1';
}

/** Con `allowedTools`, estos nombres habilitan explícitamente recursos y prompts. */
export const MCP_RESOURCES_ALLOW = '@recursos';
export const MCP_PROMPTS_ALLOW = '@prompts';

/** Tope de texto que vuelve al modelo por llamada. */
const OUTPUT_MAX = 20_000;
/** Máximo de entradas en un listado. */
const LIST_MAX = 50;

const TOOL_NAME_MAX = 64;

/**
 * Clientes que deben seguir vivos aunque un servidor no haya anunciado tools.
 * No se exporta un `closeAll()`: el proceso entero termina con ellos.
 */
const liveClients: McpToolClient[] = [];

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
export async function createMcpTools(
  servers: McpServerConfig[],
  httpServers: McpHttpServerConfig[] = [],
  options: McpToolsOptions = { resources: mcpResourcesEnabled() },
): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  const entries: Array<{ server: McpServerConfig | McpHttpServerConfig; client: McpToolClient }> = [
    ...servers.map((server) => ({ server, client: new McpClient(server) })),
    // Solo llegan si PA_MCP_HTTP=1 (ver cli.ts); apagado por defecto.
    ...httpServers.map((server) => ({ server, client: new McpHttpClient(server) })),
  ];
  for (const { server, client } of entries) {
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
      if (options.resources) {
        const taken = new Set(tools.map((tool) => tool.name));
        for (const extra of await createResourceTools(server, client)) {
          if (taken.has(extra.name)) {
            log.warn('MCP: nombre ya usado por una tool del servidor; se omite', {
              server: server.name,
              tool: extra.name,
            });
            continue;
          }
          tools.push(extra);
        }
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
  server: { name: string },
  remote: McpToolInfo,
  client: McpToolClient,
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

/** Recorta el texto que vuelve al modelo y lo dice. */
function capOutput(text: string): string {
  return text.length > OUTPUT_MAX ? `${text.slice(0, OUTPUT_MAX)}\n… (recortado)` : text;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text: capOutput(text) }], details: {}, isError };
}

/** Una línea por recurso: `uri — nombre: descripción`. */
function formatResourceList(server: string, list: McpResourceInfo[]): string {
  if (!list.length) return `El servidor MCP "${server}" no anuncia recursos.`;
  const lines = list.slice(0, LIST_MAX).map((item) => {
    const label = [item.name, item.description].filter(Boolean).join(': ');
    return `- ${item.uri}${label ? ` — ${label}` : ''}`;
  });
  if (list.length > LIST_MAX) lines.push(`… y ${list.length - LIST_MAX} más`);
  return `Recursos de "${server}":\n${lines.join('\n')}`;
}

function formatResourceContents(contents: McpResourceContent[]): string {
  if (!contents.length) return '(recurso vacío)';
  return contents
    .map((item) => {
      if (typeof item.text === 'string') return item.text;
      if (typeof item.blob === 'string') {
        return `[contenido binario${item.mimeType ? ` ${item.mimeType}` : ''} omitido]`;
      }
      return '(sin contenido)';
    })
    .join('\n\n');
}

function formatPromptList(server: string, list: McpPromptInfo[]): string {
  if (!list.length) return `El servidor MCP "${server}" no anuncia prompts.`;
  const lines = list.slice(0, LIST_MAX).map((prompt) => {
    const args = (prompt.arguments ?? [])
      .map((arg) => `${arg.name}${arg.required ? '*' : ''}`)
      .join(', ');
    return `- ${prompt.name}${args ? ` (${args})` : ''}${prompt.description ? `: ${prompt.description}` : ''}`;
  });
  if (list.length > LIST_MAX) lines.push(`… y ${list.length - LIST_MAX} más`);
  return `Prompts de "${server}" (* = obligatorio):\n${lines.join('\n')}`;
}

function formatPromptMessage(content: unknown): string {
  const parts = Array.isArray(content) ? content : [content];
  return parts
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const record = part as Record<string, unknown>;
        if (record.type === 'text' && typeof record.text === 'string') return record.text;
        return `[contenido ${typeof record.type === 'string' ? record.type : 'desconocido'} omitido]`;
      }
      return '';
    })
    .join('\n');
}

function stringArgs(raw: unknown): Record<string, string> | string {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'argumentos debe ser un objeto';
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') return `el argumento «${key}» debe ser texto`;
    out[key] = value;
  }
  return out;
}

/**
 * Herramientas de solo lectura para los recursos y prompts de un servidor.
 *
 * Solo se publican si el servidor responde al listado al arrancar. Con
 * `allowedTools`, hacen falta `@recursos` / `@prompts` en la lista. Solo se
 * leen URIs que el propio servidor anuncia en `resources/list`, y solo se usan
 * prompts anunciados en `prompts/list`: el modelo no puede pedir una URI
 * arbitraria (p. ej. un `file://` fuera de lo que el servidor ofrece).
 */
async function createResourceTools(
  server: McpServerConfig | McpHttpServerConfig,
  client: McpToolClient,
): Promise<AgentTool[]> {
  const out: AgentTool[] = [];
  const allowed = server.allowedTools;
  const wantResources = allowed === undefined || allowed.includes(MCP_RESOURCES_ALLOW);
  const wantPrompts = allowed === undefined || allowed.includes(MCP_PROMPTS_ALLOW);
  if (wantResources && (await answers(server.name, 'recursos', () => client.listResources()))) {
    out.push({
      name: mcpToolName(server.name, 'leer_recurso'),
      label: `MCP ${server.name}`,
      description: `Lista los recursos del servidor MCP ${server.name} (sin uri) o lee uno (con la uri exacta del listado). Solo lectura. (MCP externo)`,
      parameters: Type.Object({
        uri: Type.Optional(Type.String({ description: 'URI exacta tomada del listado' })),
      }),
      executionMode: 'parallel',
      execute: async (_toolCallId, rawArgs) => {
        try {
          const args = (rawArgs ?? {}) as Record<string, unknown>;
          const uri = typeof args.uri === 'string' ? args.uri.trim() : '';
          const list = await client.listResources();
          if (!uri) return textResult(formatResourceList(server.name, list));
          if (!list.some((item) => item.uri === uri)) {
            return textResult(
              `La URI «${uri}» no está entre los recursos que anuncia "${server.name}". Llama sin uri para ver el listado.`,
              true,
            );
          }
          return textResult(formatResourceContents(await client.readResource(uri)));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult(`Error al leer recursos MCP de "${server.name}": ${message}`, true);
        }
      },
    });
  }
  if (wantPrompts && (await answers(server.name, 'prompts', () => client.listPrompts()))) {
    out.push({
      name: mcpToolName(server.name, 'usar_prompt'),
      label: `MCP ${server.name}`,
      description: `Lista los prompts del servidor MCP ${server.name} (sin nombre) o devuelve el texto de uno (con nombre y argumentos). Solo lectura. (MCP externo)`,
      parameters: Type.Object({
        nombre: Type.Optional(Type.String({ description: 'Nombre exacto del prompt' })),
        argumentos: Type.Optional(
          Type.Record(Type.String(), Type.String(), { description: 'Argumentos del prompt' }),
        ),
      }),
      executionMode: 'parallel',
      execute: async (_toolCallId, rawArgs) => {
        try {
          const args = (rawArgs ?? {}) as Record<string, unknown>;
          const name = typeof args.nombre === 'string' ? args.nombre.trim() : '';
          const list = await client.listPrompts();
          if (!name) return textResult(formatPromptList(server.name, list));
          const prompt = list.find((item) => item.name === name);
          if (!prompt) {
            return textResult(
              `El prompt «${name}» no está entre los que anuncia "${server.name}". Llama sin nombre para ver el listado.`,
              true,
            );
          }
          const promptArgs = stringArgs(args.argumentos);
          if (typeof promptArgs === 'string')
            return textResult(`Prompt «${name}»: ${promptArgs}.`, true);
          const missing = (prompt.arguments ?? [])
            .filter((arg) => arg.required && !promptArgs[arg.name])
            .map((arg) => arg.name);
          if (missing.length) {
            return textResult(
              `Faltan argumentos obligatorios para «${name}»: ${missing.join(', ')}.`,
              true,
            );
          }
          const result = await client.getPrompt(name, promptArgs);
          const body = result.messages
            .map((message) => `[${message.role}] ${formatPromptMessage(message.content)}`)
            .join('\n\n');
          return textResult(
            `${result.description ? `${result.description}\n\n` : ''}${body || '(prompt vacío)'}`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return textResult(`Error al usar prompts MCP de "${server.name}": ${message}`, true);
        }
      },
    });
  }
  return out;
}

/** true si el servidor responde al listado; si no (p. ej. no implementa el método), se omite sin ruido. */
async function answers(
  server: string,
  kind: string,
  list: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await list();
    return true;
  } catch (error) {
    log.info(`MCP: el servidor no ofrece ${kind}`, {
      server,
      err: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
