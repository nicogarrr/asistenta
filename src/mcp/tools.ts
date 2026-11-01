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
  type McpResourceTemplateInfo,
  type McpServerConfig,
  type McpToolCallResult,
  type McpToolInfo,
  parseMcpServers,
} from './client.js';
import {
  McpHttpClient,
  type McpHttpServerConfig,
  mcpHttpEnabled,
  readMcpHttpServers,
} from './http-client.js';

/** Lo que el puente necesita de un cliente MCP, sea stdio o HTTP. */
interface McpToolClient {
  start(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<McpToolCallResult>;
  close(): void;
  listResources(): Promise<McpResourceInfo[]>;
  listResourceTemplates?(): Promise<McpResourceTemplateInfo[]>;
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
  /**
   * Además, plantillas de recursos (`resources/templates/list`) en leer_recurso.
   * Apagado por defecto: solo con PA_MCP_RESOURCE_TEMPLATES=1 (y PA_MCP_RESOURCES=1).
   */
  templates?: boolean;
}

/** PA_MCP_RESOURCES=1 activa recursos y prompts MCP; cualquier otro valor los deja apagados. */
export function mcpResourcesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PA_MCP_RESOURCES ?? '').trim() === '1';
}

/** PA_MCP_RESOURCE_TEMPLATES=1 activa las plantillas de recursos; cualquier otro valor las deja apagadas. */
export function mcpResourceTemplatesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PA_MCP_RESOURCE_TEMPLATES ?? '').trim() === '1';
}

/** Tope de longitud de cada valor que rellena una plantilla. */
const TEMPLATE_VALUE_MAX = 200;

/**
 * Rellena una plantilla RFC 6570 de nivel 1 (solo `{nombre}`). Cada valor se
 * codifica entero (también `/`, `?`, `#`), así que no puede salirse del hueco de
 * la plantilla; `.` y `..` se rechazan. Plantillas con operadores (`{+x}`,
 * `{/x}`, `{?x}`…) o varias variables en una expresión no se admiten. Devuelve
 * la URI o un error en castellano.
 */
export function expandUriTemplate(
  template: string,
  values: Record<string, unknown>,
): { uri: string } | { error: string } {
  const expressions = template.match(/\{[^{}]*\}/g) ?? [];
  if (/[{}]/.test(template.replace(/\{[^{}]*\}/g, ''))) {
    return { error: `La plantilla «${template}» está mal formada.` };
  }
  for (const expression of expressions) {
    if (!/^\{[A-Za-z0-9_]+\}$/.test(expression)) {
      return { error: `La plantilla «${template}» usa una forma no admitida (${expression}).` };
    }
  }
  let failure: string | undefined;
  const uri = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (typeof value !== 'string' || !value.trim()) {
      failure ??= `Falta el valor de «${name}».`;
      return '';
    }
    if (value === '.' || value === '..' || value.length > TEMPLATE_VALUE_MAX) {
      failure ??= `Valor no admitido para «${name}».`;
      return '';
    }
    return encodeURIComponent(value).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  });
  return failure ? { error: failure } : { uri };
}

/** Con `allowedTools`, estos nombres habilitan explícitamente recursos y prompts. */
export const MCP_RESOURCES_ALLOW = '@recursos';
export const MCP_PROMPTS_ALLOW = '@prompts';

/**
 * Lineas de `pa doctor` sobre recursos y prompts MCP (PA_MCP_RESOURCES). No
 * conecta con ningun servidor: dice, por servidor en uso, que herramientas
 * publicaria si el servidor los lista, segun `allowedTools`. Nunca muestra URLs.
 */
export function mcpResourcesDoctorLines(env: NodeJS.ProcessEnv = process.env): string[] {
  const label = 'mcp recursos    ';
  if (!mcpResourcesEnabled(env)) return [`${label}apagado (PA_MCP_RESOURCES=1 para activarlo)`];
  const servers: Array<{ name: string; allowedTools?: string[] }> = [
    ...parseMcpServers(env.PA_MCP_SERVERS),
    // Igual que en el arranque: los servidores HTTP solo cuentan con PA_MCP_HTTP=1.
    ...(mcpHttpEnabled(env) ? readMcpHttpServers(env.PA_MCP_SERVERS).servers : []),
  ];
  if (!servers.length) return [`${label}activado, pero sin servidores en PA_MCP_SERVERS`];
  const lines = [`${label}activado (PA_MCP_RESOURCES=1)`];
  lines.push(
    `  plantillas: ${mcpResourceTemplatesEnabled(env) ? 'activadas (PA_MCP_RESOURCE_TEMPLATES=1)' : 'apagadas (PA_MCP_RESOURCE_TEMPLATES=1 para activarlas)'}`,
  );
  for (const server of servers) {
    const allowed = server.allowedTools;
    const res = allowed === undefined || allowed.includes(MCP_RESOURCES_ALLOW);
    const pro = allowed === undefined || allowed.includes(MCP_PROMPTS_ALLOW);
    const names = [
      ...(res ? [mcpToolName(server.name, 'leer_recurso')] : []),
      ...(pro ? [mcpToolName(server.name, 'usar_prompt')] : []),
    ];
    if (!names.length) {
      lines.push(
        `  ${server.name}: ninguno: allowedTools sin ${MCP_RESOURCES_ALLOW} ni ${MCP_PROMPTS_ALLOW}`,
      );
      continue;
    }
    const missing = !res
      ? `; recursos no: falta ${MCP_RESOURCES_ALLOW} en allowedTools`
      : !pro
        ? `; prompts no: falta ${MCP_PROMPTS_ALLOW} en allowedTools`
        : '';
    lines.push(`  ${server.name}: ${names.join(' y ')} (si el servidor los lista)${missing}`);
  }
  return lines;
}

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

/** Servidor MCP vivo tal como lo ve `/mcp`: nombre, `allowedTools` y su cliente. */
export interface McpLiveServer {
  name: string;
  allowedTools?: string[];
  client: Pick<McpToolClient, 'listResources' | 'listPrompts' | 'listResourceTemplates'>;
}

/** Los servidores que arrancaron, para `/mcp` (solo lectura; no se cierran aquí). */
const liveServers: McpLiveServer[] = [];

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
  options: McpToolsOptions = {
    resources: mcpResourcesEnabled(),
    templates: mcpResourceTemplatesEnabled(),
  },
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
      liveServers.push({ name: server.name, allowedTools: server.allowedTools, client });
      const allowed = server.allowedTools;
      const listed =
        allowed === undefined
          ? remoteTools
          : remoteTools.filter((remote) => allowed.includes(remote.name));
      // `readOnlyOnly` (REA): fuera lo que no se declare de solo lectura o no destructivo.
      const selected =
        'readOnlyOnly' in server && server.readOnlyOnly ? listed.filter(isReadOnlyTool) : listed;
      for (const remote of selected) {
        tools.push(createAgentTool(server, remote, client));
      }
      if (options.resources) {
        const taken = new Set(tools.map((tool) => tool.name));
        for (const extra of await createResourceTools(server, client, options.templates === true)) {
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

/**
 * Una tool cuenta como de solo lectura si el servidor lo dice (`readOnlyHint`)
 * o la marca expresamente como no destructiva. Sin pistas, no: el valor por
 * defecto de MCP para una tool sin `readOnlyHint` es «puede destruir».
 */
export function isReadOnlyTool(tool: McpToolInfo): boolean {
  const hints = tool.annotations;
  if (!hints) return false;
  if (hints.destructiveHint === true) return false;
  return hints.readOnlyHint === true || hints.destructiveHint === false;
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

function formatTemplateList(server: string, list: McpResourceTemplateInfo[]): string {
  if (!list.length) return `El servidor MCP "${server}" no anuncia plantillas.`;
  const lines = list.slice(0, LIST_MAX).map((item) => {
    const label = [item.name, item.description].filter(Boolean).join(': ');
    return `- ${item.uriTemplate}${label ? ` — ${label}` : ''}`;
  });
  if (list.length > LIST_MAX) lines.push(`… y ${list.length - LIST_MAX} más`);
  return `Plantillas de "${server}" (usa plantilla + valores):\n${lines.join('\n')}`;
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
  templates = false,
): Promise<AgentTool[]> {
  const out: AgentTool[] = [];
  const allowed = server.allowedTools;
  const wantResources = allowed === undefined || allowed.includes(MCP_RESOURCES_ALLOW);
  const wantPrompts = allowed === undefined || allowed.includes(MCP_PROMPTS_ALLOW);
  if (wantResources && (await answers(server.name, 'recursos', () => client.listResources()))) {
    // Plantillas: solo si están activadas y el servidor responde al listado.
    const listTemplates = client.listResourceTemplates?.bind(client);
    const useTemplates =
      templates &&
      listTemplates !== undefined &&
      (await answers(server.name, 'plantillas', () => listTemplates()));
    out.push({
      name: mcpToolName(server.name, 'leer_recurso'),
      label: `MCP ${server.name}`,
      description: useTemplates
        ? `Lista los recursos y plantillas del servidor MCP ${server.name} (sin uri) o lee uno (con la uri exacta del listado, o con una plantilla del listado y sus valores). Solo lectura. (MCP externo)`
        : `Lista los recursos del servidor MCP ${server.name} (sin uri) o lee uno (con la uri exacta del listado). Solo lectura. (MCP externo)`,
      parameters: useTemplates
        ? Type.Object({
            uri: Type.Optional(Type.String({ description: 'URI exacta tomada del listado' })),
            plantilla: Type.Optional(
              Type.String({ description: 'Plantilla exacta tomada del listado' }),
            ),
            valores: Type.Optional(
              Type.Record(Type.String(), Type.String(), {
                description: 'Valor de cada {variable} de la plantilla',
              }),
            ),
          })
        : Type.Object({
            uri: Type.Optional(Type.String({ description: 'URI exacta tomada del listado' })),
          }),
      executionMode: 'parallel',
      execute: async (_toolCallId, rawArgs) => {
        try {
          const args = (rawArgs ?? {}) as Record<string, unknown>;
          const plantilla =
            useTemplates && typeof args.plantilla === 'string' ? args.plantilla.trim() : '';
          if (plantilla && listTemplates) {
            const known = await listTemplates();
            if (!known.some((item) => item.uriTemplate === plantilla)) {
              return textResult(
                `La plantilla «${plantilla}» no está entre las plantillas que anuncia "${server.name}". Llama sin uri para ver el listado.`,
                true,
              );
            }
            const valores =
              args.valores && typeof args.valores === 'object'
                ? (args.valores as Record<string, unknown>)
                : {};
            const expanded = expandUriTemplate(plantilla, valores);
            if ('error' in expanded) return textResult(expanded.error, true);
            return textResult(formatResourceContents(await client.readResource(expanded.uri)));
          }
          const uri = typeof args.uri === 'string' ? args.uri.trim() : '';
          const list = await client.listResources();
          if (!uri) {
            const text = formatResourceList(server.name, list);
            if (!useTemplates || !listTemplates) return textResult(text);
            return textResult(`${text}\n${formatTemplateList(server.name, await listTemplates())}`);
          }
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

/** Uso de `/mcp` en Telegram. */
export const MCP_COMMAND_USAGE = 'No te he pillado. ¿Quieres ver los recursos o los prompts?';
const MCP_COMMAND_ITEMS = 20;
const MCP_COMMAND_TEXT = 80;
const MCP_COMMAND_TIMEOUT_MS = 10_000;

/** Una línea de texto simple y corta: sin saltos ni caracteres de control. */
function commandLine(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out +=
      code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029
        ? ' '
        : ch;
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > MCP_COMMAND_TEXT ? `${out.slice(0, MCP_COMMAND_TEXT - 1)}…` : out;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('sin respuesta')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `/mcp recursos|prompts`: qué recursos o prompts ofrece cada servidor MCP en
 * marcha. Solo lectura: lista, nunca lee un recurso ni usa un prompt. Respeta
 * lo mismo que las herramientas: apagado sin PA_MCP_RESOURCES=1 y, con
 * `allowedTools`, solo servidores que incluyan `@recursos` / `@prompts`.
 * Cada servidor tiene un tope de tiempo; uno que no responde no bloquea al resto.
 * Con PA_MCP_RESOURCE_TEMPLATES=1, `/mcp recursos` lista también las plantillas.
 */
export async function mcpCommandText(
  rawArgs: string,
  opts: { env?: NodeJS.ProcessEnv; servers?: readonly McpLiveServer[]; timeoutMs?: number } = {},
): Promise<string> {
  if (!mcpResourcesEnabled(opts.env ?? process.env)) {
    return 'Los recursos y prompts MCP están apagados: pon PA_MCP_RESOURCES=1 en .env y reinicia.';
  }
  const arg = rawArgs.trim().toLowerCase();
  const kind =
    arg === 'recursos' || arg === 'resources' ? 'recursos' : arg === 'prompts' ? 'prompts' : null;
  if (!kind) return MCP_COMMAND_USAGE;
  const servers = opts.servers ?? liveServers;
  if (!servers.length) return 'No hay ningún servidor MCP en marcha.';
  const marker = kind === 'recursos' ? MCP_RESOURCES_ALLOW : MCP_PROMPTS_ALLOW;
  const blocks = await Promise.all(
    servers.map(async (server): Promise<string> => {
      const name = commandLine(server.name);
      if (server.allowedTools !== undefined && !server.allowedTools.includes(marker)) {
        return `${name}: no publicado (falta ${marker} en allowedTools)`;
      }
      let items: string[];
      try {
        items =
          kind === 'recursos'
            ? (
                await withTimeout(
                  server.client.listResources(),
                  opts.timeoutMs ?? MCP_COMMAND_TIMEOUT_MS,
                )
              ).map((r) =>
                r.name ? `${commandLine(r.name)} (${commandLine(r.uri)})` : commandLine(r.uri),
              )
            : (
                await withTimeout(
                  server.client.listPrompts(),
                  opts.timeoutMs ?? MCP_COMMAND_TIMEOUT_MS,
                )
              ).map((pr) =>
                pr.description
                  ? `${commandLine(pr.name)}: ${commandLine(pr.description)}`
                  : commandLine(pr.name),
              );
      } catch {
        return `${name}: no responde`;
      }
      if (
        kind === 'recursos' &&
        mcpResourceTemplatesEnabled(opts.env ?? process.env) &&
        server.client.listResourceTemplates
      ) {
        try {
          const templates = await withTimeout(
            server.client.listResourceTemplates(),
            opts.timeoutMs ?? MCP_COMMAND_TIMEOUT_MS,
          );
          for (const tpl of templates) {
            items.push(
              `plantilla ${tpl.name ? `${commandLine(tpl.name)} (${commandLine(tpl.uriTemplate)})` : commandLine(tpl.uriTemplate)}`,
            );
          }
        } catch {
          items.push('plantillas: no responden');
        }
      }
      if (!items.length) return `${name}: ninguno`;
      const shown = items.slice(0, MCP_COMMAND_ITEMS).map((line) => `• ${line}`);
      if (items.length > MCP_COMMAND_ITEMS)
        shown.push(`… y ${items.length - MCP_COMMAND_ITEMS} más`);
      return `${name}:\n${shown.join('\n')}`;
    }),
  );
  return `${kind === 'recursos' ? 'Recursos' : 'Prompts'} MCP (solo lectura):\n\n${blocks.join('\n\n')}`;
}
