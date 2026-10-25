/**
 * Cliente MCP por stdio.
 *
 * El transporte es el par stdin/stdout del proceso hijo: cada mensaje JSON-RPC
 * ocupa una linea. stderr nunca se parsea (solo se registra) y las lineas de
 * stdout que no son JSON se ignoran, porque muchos servidores escriben avisos
 * de arranque antes de hablar el protocolo.
 *
 * Los ids son incrementales y cada peticion tiene su propio timeout. Si el
 * proceso muere, todas las peticiones pendientes se rechazan en vez de quedar
 * colgadas hasta el timeout.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { log } from '../log.js';

/** Configuracion de un servidor MCP local, normalmente leida de PA_MCP_SERVERS. */
export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Herramienta tal como la anuncia `tools/list`. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Resultado normalizado de `tools/call`. */
export interface McpToolCallResult {
  text: string;
  isError: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = item;
  }
  return result;
}

/**
 * Lee la variable PA_MCP_SERVERS.
 *
 * Se acepta solo un array JSON. Se descartan las entradas sin nombre o comando,
 * las que usan un nombre fuera de `[a-zA-Z0-9_-]+` y los nombres repetidos
 * (gana la primera aparicion). Un JSON invalido se trata como "no hay
 * servidores".
 */
export function parseMcpServers(raw: string | undefined): McpServerConfig[] {
  if (!raw || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const servers: McpServerConfig[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    if (typeof item.name !== 'string' || typeof item.command !== 'string') continue;
    const name = item.name.trim();
    const command = item.command.trim();
    if (!name || !command || !NAME_PATTERN.test(name) || seen.has(name)) continue;

    const server: McpServerConfig = { name, command };
    const args = stringArray(item.args);
    if (args) server.args = args;
    const env = stringRecord(item.env);
    if (env) server.env = env;
    if (
      typeof item.timeoutMs === 'number' &&
      Number.isFinite(item.timeoutMs) &&
      item.timeoutMs > 0
    ) {
      server.timeoutMs = item.timeoutMs;
    }
    seen.add(name);
    servers.push(server);
  }
  return servers;
}

/**
 * Cliente de un servidor MCP local.
 *
 * `start()` hace el handshake y deja el proceso listo; `listTools()` y
 * `callTool()` hablan JSON-RPC sobre el mismo proceso. `close()` mata el hijo y
 * es idempotente.
 */
export class McpClient {
  readonly #config: McpServerConfig;
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = '';
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #startWaiter: { resolve: () => void; reject: (error: Error) => void } | undefined;
  #failure: Error | undefined;
  #ready = false;
  #closed = false;

  constructor(config: McpServerConfig) {
    this.#config = config;
  }

  /** Nombre del servidor, util para logs y para construir nombres de tools. */
  get name(): string {
    return this.#config.name;
  }

  /** Arranca el proceso, hace `initialize` y envia `notifications/initialized`. */
  async start(): Promise<void> {
    if (this.#closed) {
      throw new Error(`El cliente MCP "${this.#config.name}" ya esta cerrado.`);
    }
    if (this.#ready) return;
    if (this.#failure) throw this.#failure;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#config.command, this.#config.args ?? [], {
        env: { ...process.env, ...this.#config.env },
        windowsHide: true,
      });
    } catch (error) {
      throw new Error(
        `No se pudo arrancar el servidor MCP "${this.#config.name}": ${errorMessage(error)}`,
      );
    }
    this.#child = child;
    this.#attach(child);

    await new Promise<void>((resolve, reject) => {
      this.#startWaiter = { resolve, reject };
    });
    if (this.#failure) throw this.#failure;

    try {
      await this.#request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'asistenta', version: '0.1.0' },
      });
      this.#notify('notifications/initialized');
      this.#ready = true;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Lista las herramientas anunciadas por el servidor. */
  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.#request<unknown>('tools/list', {});
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new Error(
        `El servidor MCP "${this.#config.name}" devolvio una lista de herramientas invalida.`,
      );
    }
    const tools: McpToolInfo[] = [];
    for (const item of result.tools) {
      if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) {
        log.warn('Herramienta MCP ignorada: nombre invalido', {
          server: this.#config.name,
        });
        continue;
      }
      const info: McpToolInfo = { name: item.name };
      if (typeof item.description === 'string') info.description = item.description;
      if (isRecord(item.inputSchema)) info.inputSchema = item.inputSchema;
      tools.push(info);
    }
    return tools;
  }

  /**
   * Llama a una tool remota. Concatena los bloques de texto en orden; los
   * bloques que no son texto se ignoran.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
    const result = await this.#request<unknown>('tools/call', {
      name,
      arguments: args,
    });
    if (!isRecord(result)) {
      throw new Error(
        `El servidor MCP "${this.#config.name}" devolvio un resultado invalido para "${name}".`,
      );
    }
    const texts: string[] = [];
    if (Array.isArray(result.content)) {
      for (const block of result.content) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text);
        }
      }
    }
    return { text: texts.join(''), isError: result.isError === true };
  }

  /** Cierra el proceso. Es idempotente y no espera a que termine. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error(`El cliente MCP "${this.#config.name}" fue cerrado.`);
    this.#failure = error;
    const waiter = this.#startWaiter;
    this.#startWaiter = undefined;
    waiter?.reject(error);
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
    const child = this.#child;
    this.#child = undefined;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // El pipe ya estaba cerrado.
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        // El proceso ya no existe.
      }
    }
  }

  #attach(child: ChildProcessWithoutNullStreams): void {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.#onStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) {
        log.warn('stderr de servidor MCP', {
          server: this.#config.name,
          text: text.slice(0, 2000),
        });
      }
    });
    child.on('spawn', () => {
      const waiter = this.#startWaiter;
      this.#startWaiter = undefined;
      waiter?.resolve();
    });
    child.on('error', (error) => {
      this.#fail(
        new Error(`No se pudo arrancar el servidor MCP "${this.#config.name}": ${error.message}`),
      );
    });
    child.on('exit', (code, signal) => {
      if (this.#closed) return;
      const detail = signal ? `senal ${signal}` : `codigo ${code ?? 'desconocido'}`;
      this.#fail(new Error(`El proceso MCP "${this.#config.name}" termino (${detail}).`));
    });
    child.stdin.on('error', (error) => {
      this.#fail(
        new Error(`Se perdio la entrada del servidor MCP "${this.#config.name}": ${error.message}`),
      );
    });
  }

  #onStdout(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) this.#handleLine(line);
      newline = this.#buffer.indexOf('\n');
    }
  }

  #handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Aviso no JSON por stdout: se ignora.
      return;
    }
    if (!isRecord(parsed)) return;
    const id = parsed.id;
    if (typeof id !== 'number') return;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);

    if (isRecord(parsed.error)) {
      const message =
        typeof parsed.error.message === 'string'
          ? parsed.error.message
          : 'error JSON-RPC sin mensaje';
      pending.reject(
        new Error(
          `El servidor MCP "${this.#config.name}" fallo en "${pending.method}": ${message}`,
        ),
      );
      return;
    }
    if ('result' in parsed) {
      pending.resolve(parsed.result);
      return;
    }
    pending.reject(
      new Error(
        `Respuesta JSON-RPC invalida del servidor MCP "${this.#config.name}" para "${pending.method}".`,
      ),
    );
  }

  #write(message: unknown): void {
    if (this.#failure) throw this.#failure;
    const child = this.#child;
    if (!child) throw new Error(`El cliente MCP "${this.#config.name}" no esta iniciado.`);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #notify(method: string, params?: unknown): void {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  #request<T>(method: string, params?: unknown): Promise<T> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (!this.#child) {
      return Promise.reject(new Error(`El cliente MCP "${this.#config.name}" no esta iniciado.`));
    }
    const id = this.#nextId++;
    const timeoutMs = this.#config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new Error(
            `Tiempo de espera agotado (${timeoutMs} ms) esperando "${method}" del servidor MCP "${this.#config.name}".`,
          ),
        );
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
      });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    if (!this.#failure) this.#failure = error;
    const waiter = this.#startWaiter;
    this.#startWaiter = undefined;
    waiter?.reject(this.#failure);
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(this.#failure);
    }
  }
}
