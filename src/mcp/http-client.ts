/**
 * Cliente MCP por HTTP («Streamable HTTP»), apagado por defecto.
 *
 * Solo se usa con PA_MCP_HTTP=1. Las entradas de PA_MCP_SERVERS que llevan
 * `url` (en vez de `command`) se hablan por HTTP: cada mensaje JSON-RPC es un
 * POST; la respuesta llega como JSON o como `text/event-stream` (SSE), y la
 * cabecera `Mcp-Session-Id` que devuelve `initialize` se reenvia despues.
 *
 * Seguridad (solo mas estricto que stdio):
 * - solo `https://`, o `http://` hacia el propio equipo (localhost/127.x/::1);
 * - las redirecciones se rechazan (el token no viaja a otro host);
 * - el token sale del almacen privado (`mcp:<nombre>:token`), nunca de la
 *   configuracion, y nunca aparece en logs ni en mensajes de error;
 * - 401/403 hace fallar el arranque: `createMcpTools` omite el servidor;
 * - cada peticion tiene su timeout y la respuesta un tope de tamano.
 */
import { log } from '../log.js';
import { vaultGet } from '../vault.js';
import {
  type McpPromptInfo,
  type McpPromptResult,
  type McpResourceContent,
  type McpResourceInfo,
  type McpToolCallResult,
  type McpToolInfo,
  parsePromptGet,
  parsePromptList,
  parseResourceList,
  parseResourceRead,
  parseToolCall,
  parseToolList,
} from './client.js';

/** Configuracion de un servidor MCP remoto (entrada de PA_MCP_SERVERS con `url`). */
export interface McpHttpServerConfig {
  name: string;
  url: string;
  timeoutMs?: number;
  /** Si se define, solo se publican las tools de esta lista (comparacion exacta). */
  allowedTools?: string[];
}

export type SecretGetter = (key: string) => Promise<string | null | undefined>;

const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PROTOCOL_VERSION = '2025-03-26';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** true si PA_MCP_HTTP activa el transporte HTTP (apagado por defecto). */
export function mcpHttpEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PA_MCP_HTTP ?? '').trim() === '1';
}

/** `https:` siempre; `http:` solo hacia el propio equipo. Devuelve null si no vale. */
export function checkMcpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)) return url;
  return null;
}

/** Entrada HTTP de PA_MCP_SERVERS que no se usa, con el motivo (para `pa doctor`). */
export interface McpHttpSkipped {
  name: string;
  reason: string;
}

/** Resultado de leer las entradas HTTP de PA_MCP_SERVERS. */
export interface McpHttpServersReport {
  servers: McpHttpServerConfig[];
  skipped: McpHttpSkipped[];
  /** true si PA_MCP_SERVERS tiene texto pero no es una lista JSON. */
  invalid: boolean;
}

const URL_NOT_ALLOWED =
  'URL no permitida (https, o http solo a localhost; sin usuario ni contraseña)';

/**
 * Clasifica las entradas HTTP de PA_MCP_SERVERS (las que tienen `url` y no
 * `command`): las validas y las omitidas con su motivo. Nunca guarda la URL de
 * una entrada omitida (podria llevar credenciales).
 */
export function readMcpHttpServers(raw: string | undefined): McpHttpServersReport {
  const report: McpHttpServersReport = { servers: [], skipped: [], invalid: false };
  if (!raw || !raw.trim()) return report;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    report.invalid = true;
    return report;
  }
  if (!Array.isArray(parsed)) {
    report.invalid = true;
    return report;
  }
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!isRecord(item) || typeof item.url !== 'string') continue;
    if (typeof item.command === 'string') continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const shown = name ? name.slice(0, 40) : '(sin nombre)';
    if (!name || !NAME_PATTERN.test(name)) {
      report.skipped.push({
        name: shown,
        reason: 'nombre no válido (solo letras, números, _ y -)',
      });
      continue;
    }
    if (seen.has(name)) {
      report.skipped.push({ name: shown, reason: 'nombre repetido' });
      continue;
    }
    const url = checkMcpUrl(item.url.trim());
    if (!url) {
      report.skipped.push({ name: shown, reason: URL_NOT_ALLOWED });
      continue;
    }
    const server: McpHttpServerConfig = { name, url: url.toString() };
    if (
      typeof item.timeoutMs === 'number' &&
      Number.isFinite(item.timeoutMs) &&
      item.timeoutMs > 0
    ) {
      server.timeoutMs = item.timeoutMs;
    }
    if (Array.isArray(item.allowedTools)) {
      server.allowedTools = item.allowedTools
        .filter((tool): tool is string => typeof tool === 'string' && tool.trim().length > 0)
        .map((tool) => tool.trim());
    }
    seen.add(name);
    report.servers.push(server);
  }
  return report;
}

/**
 * Lee las entradas HTTP de PA_MCP_SERVERS (las que tienen `url` y no `command`).
 * Se descartan nombres invalidos o repetidos y URLs no permitidas (con aviso).
 */
export function parseMcpHttpServers(raw: string | undefined): McpHttpServerConfig[] {
  const report = readMcpHttpServers(raw);
  for (const skipped of report.skipped) {
    if (skipped.reason !== URL_NOT_ALLOWED) continue;
    log.warn('Servidor MCP HTTP omitido: URL no permitida (https, o http solo a localhost)', {
      server: skipped.name,
    });
  }
  return report.servers;
}

/**
 * Lineas de `pa doctor` sobre los servidores MCP por HTTP: cuales estan
 * configurados y cuales se omiten y por que. No conecta con nadie. Del token
 * solo dice si esta guardado; su valor nunca sale. De la URL solo se muestra el
 * origen (sin ruta ni parametros, que podrian llevar secretos).
 */
export async function mcpHttpDoctorLines(
  env: NodeJS.ProcessEnv = process.env,
  getSecret: SecretGetter = vaultGet,
): Promise<string[]> {
  const label = 'mcp http        ';
  const report = readMcpHttpServers(env.PA_MCP_SERVERS);
  const enabled = mcpHttpEnabled(env);
  if (report.invalid) return [`${label}PA_MCP_SERVERS no es una lista JSON válida`];
  if (!report.servers.length && !report.skipped.length) {
    return [
      `${label}${enabled ? 'activado, pero' : 'apagado (PA_MCP_HTTP=1),'} sin servidores con "url" en PA_MCP_SERVERS`,
    ];
  }
  const lines = [
    `${label}${enabled ? 'activado (PA_MCP_HTTP=1)' : 'apagado (PA_MCP_HTTP=1 para activarlo)'}`,
  ];
  for (const server of report.servers) {
    if (!enabled) {
      lines.push(`  ${server.name}: omitido: PA_MCP_HTTP no es 1 (apagado por defecto)`);
      continue;
    }
    const token = await getSecret(`mcp:${server.name}:token`).catch(() => undefined);
    const hasToken = typeof token === 'string' && token.trim().length > 0;
    lines.push(
      `  ${server.name}: configurado (${new URL(server.url).origin}; token ${hasToken ? 'guardado' : `sin guardar (mcp:${server.name}:token)`})`,
    );
  }
  for (const skipped of report.skipped) lines.push(`  ${skipped.name}: omitido: ${skipped.reason}`);
  return lines;
}

/** Busca en un cuerpo SSE el mensaje JSON-RPC con el id pedido. */
export function findSseResponse(body: string, id: number): unknown {
  for (const block of body.replace(/\r\n?/g, '\n').split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      continue;
    }
    if (isRecord(msg) && msg.id === id) return msg;
  }
  return undefined;
}

/** El servidor olvido la sesion (HTTP 404 con `Mcp-Session-Id`). */
class SessionExpiredError extends Error {}

/** Cliente de un servidor MCP remoto por HTTP. Misma forma que `McpClient`. */
export class McpHttpClient {
  readonly #config: McpHttpServerConfig;
  readonly #getSecret: SecretGetter;
  #token: string | undefined;
  #sessionId: string | undefined;
  #nextId = 1;
  #ready = false;
  #starting: Promise<void> | undefined;
  #closed = false;

  constructor(config: McpHttpServerConfig, getSecret: SecretGetter = vaultGet) {
    this.#config = config;
    this.#getSecret = getSecret;
  }

  get name(): string {
    return this.#config.name;
  }

  /** `initialize` + `notifications/initialized`. Idempotente. */
  async start(): Promise<void> {
    if (this.#closed) throw new Error(`El cliente MCP "${this.#config.name}" ya esta cerrado.`);
    if (this.#ready) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.#init().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async listTools(): Promise<McpToolInfo[]> {
    return parseToolList(this.#config.name, await this.#request('tools/list', {}));
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
    const result = await this.#request('tools/call', { name, arguments: args });
    return parseToolCall(this.#config.name, name, result);
  }

  /** Lista los recursos del servidor (`resources/list`). */
  async listResources(): Promise<McpResourceInfo[]> {
    return parseResourceList(this.#config.name, await this.#request('resources/list', {}));
  }

  /** Lee un recurso (`resources/read`) y devuelve sus bloques de contenido. */
  async readResource(uri: string): Promise<McpResourceContent[]> {
    const target = uri.trim();
    if (!target) throw new Error('readResource: falta la URI del recurso.');
    const result = await this.#request('resources/read', { uri: target });
    return parseResourceRead(this.#config.name, target, result);
  }

  /** Lista los prompts del servidor (`prompts/list`). */
  async listPrompts(): Promise<McpPromptInfo[]> {
    return parsePromptList(this.#config.name, await this.#request('prompts/list', {}));
  }

  /** Obtiene un prompt con sus argumentos ya sustituidos (`prompts/get`). */
  async getPrompt(name: string, args: Record<string, string> = {}): Promise<McpPromptResult> {
    const target = name.trim();
    if (!target) throw new Error('getPrompt: falta el nombre del prompt.');
    const result = await this.#request('prompts/get', { name: target, arguments: args });
    return parsePromptGet(this.#config.name, target, result);
  }

  close(): void {
    this.#closed = true;
    this.#ready = false;
  }

  async #init(): Promise<void> {
    const token = await this.#getSecret(`mcp:${this.#config.name}:token`);
    this.#token = typeof token === 'string' && token.trim() ? token.trim() : undefined;
    await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'asistenta', version: '0.1.0' },
    });
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' }, undefined);
    this.#ready = true;
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) throw new Error(`El cliente MCP "${this.#config.name}" ya esta cerrado.`);
    let msg: unknown;
    try {
      const id = this.#nextId++;
      msg = await this.#post({ jsonrpc: '2.0', id, method, params }, id);
    } catch (error) {
      // Sesion caducada (HTTP 404 con Mcp-Session-Id): la especificacion pide
      // empezar una sesion nueva con `initialize`. Se hace una sola vez.
      if (!(error instanceof SessionExpiredError) || method === 'initialize') throw error;
      log.warn('Sesion MCP caducada: se reinicia', { server: this.#config.name });
      this.#sessionId = undefined;
      this.#ready = false;
      await this.start();
      const id = this.#nextId++;
      msg = await this.#post({ jsonrpc: '2.0', id, method, params }, id);
    }
    if (!isRecord(msg)) {
      throw new Error(
        `Respuesta JSON-RPC invalida del servidor MCP "${this.#config.name}" para "${method}".`,
      );
    }
    if (isRecord(msg.error)) {
      const text =
        typeof msg.error.message === 'string' ? msg.error.message : 'error JSON-RPC sin mensaje';
      throw new Error(`El servidor MCP "${this.#config.name}" fallo en "${method}": ${text}`);
    }
    if (!('result' in msg)) {
      throw new Error(
        `Respuesta JSON-RPC invalida del servidor MCP "${this.#config.name}" para "${method}".`,
      );
    }
    return msg.result;
  }

  /** POST de un mensaje. Con `id` devuelve la respuesta; sin `id` (notificacion) nada. */
  async #post(body: unknown, id: number | undefined): Promise<unknown> {
    const name = this.#config.name;
    const timeoutMs = this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
    };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    if (this.#sessionId) headers['mcp-session-id'] = this.#sessionId;
    const method = isRecord(body) && typeof body.method === 'string' ? body.method : '?';
    let res: Response;
    try {
      res = await fetch(this.#config.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new Error(
        timedOut
          ? `Tiempo de espera agotado (${timeoutMs} ms) esperando "${method}" del servidor MCP "${name}".`
          : `No se pudo conectar con el servidor MCP "${name}".`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new Error(
        `El servidor MCP "${name}" rechazo la autorizacion (HTTP ${res.status}); revisa mcp:${name}:token en el almacen privado.`,
      );
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel();
      throw new Error(
        `El servidor MCP "${name}" intento redirigir (HTTP ${res.status}); no se sigue.`,
      );
    }
    if (res.status === 404 && headers['mcp-session-id']) {
      await res.body?.cancel();
      throw new SessionExpiredError(`La sesion del servidor MCP "${name}" ha caducado (HTTP 404).`);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`El servidor MCP "${name}" respondio HTTP ${res.status} a "${method}".`);
    }
    const session = res.headers.get('mcp-session-id');
    if (session && /^[\x21-\x7e]{1,256}$/.test(session)) this.#sessionId = session;
    if (id === undefined) {
      await res.body?.cancel();
      return undefined;
    }
    const text = await readCapped(res, MAX_RESPONSE_BYTES, name);
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (type.includes('text/event-stream')) return findSseResponse(text, id);
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
}

async function readCapped(res: Response, max: number, name: string): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`La respuesta del servidor MCP "${name}" supera ${max} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
