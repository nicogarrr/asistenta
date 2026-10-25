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
 *
 * `ensureAlive()` permite revivir un servidor que se cayo: reinicia el proceso
 * con espera creciente (250, 500 y 1000 ms) y un maximo de tres reinicios. Con
 * `reconnect: true`, `callTool()` hace ese reintento una vez antes de rendirse.
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
  /** Si se define, solo se publican las tools de esta lista (comparacion exacta). */
  allowedTools?: string[];
  /** Si es true, `callTool` reinicia el proceso una vez y reintenta la llamada. */
  reconnect?: boolean;
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

/** Recurso tal como lo anuncia `resources/list`. */
export interface McpResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** Contenido devuelto por `resources/read`; el servidor manda `text` o `blob`. */
export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/** Argumento declarado por un prompt. */
export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/** Prompt tal como lo anuncia `prompts/list`. */
export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

/** Mensaje devuelto por `prompts/get`; el contenido queda tal cual lo manda el servidor. */
export interface McpPromptMessage {
  role: string;
  content: unknown;
}

/** Resultado normalizado de `prompts/get`. */
export interface McpPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

const DEFAULT_TIMEOUT_MS = 15_000;
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_RESTARTS = 3;
const RESTART_DELAYS_MS = [250, 500, 1000] as const;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    if (Array.isArray(item.allowedTools)) {
      server.allowedTools = item.allowedTools
        .filter((tool): tool is string => typeof tool === 'string' && tool.trim().length > 0)
        .map((tool) => tool.trim());
    }
    if (typeof item.reconnect === 'boolean') server.reconnect = item.reconnect;
    seen.add(name);
    servers.push(server);
  }
  return servers;
}

/**
 * Cliente de un servidor MCP local.
 *
 * `start()` hace el handshake y deja el proceso listo; los metodos publicos
 * hablan JSON-RPC sobre el mismo proceso. `close()` mata el hijo y es
 * idempotente.
 */
export class McpClient {
  readonly #config: McpServerConfig;
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = '';
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #startWaiter: { resolve: () => void; reject: (error: Error) => void } | undefined;
  #starting: Promise<void> | undefined;
  #recovering: Promise<void> | undefined;
  #failure: Error | undefined;
  #ready = false;
  #closed = false;
  #restarts = 0;

  constructor(config: McpServerConfig) {
    this.#config = config;
  }

  /** Nombre del servidor, util para logs y para construir nombres de tools. */
  get name(): string {
    return this.#config.name;
  }

  /**
   * Arranca el proceso, hace `initialize` y envia `notifications/initialized`.
   *
   * Es idempotente: llamarlo otra vez con el cliente listo no lanza otro
   * proceso, y dos llamadas concurrentes comparten el mismo arranque.
   */
  async start(): Promise<void> {
    if (this.#closed) {
      throw new Error(`El cliente MCP "${this.#config.name}" ya esta cerrado.`);
    }
    if (this.#ready && this.#processAlive()) return;
    if (this.#failure) throw this.#failure;
    if (this.#starting) return this.#starting;

    this.#starting = this.#launch().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  /**
   * Comprueba que el proceso sigue vivo y, si no, lo reinicia.
   *
   * La espera crece entre reinicios (250, 500 y 1000 ms) y solo se permiten
   * tres. Llamarlo con el cliente ya sano no hace nada.
   */
  async ensureAlive(): Promise<void> {
    if (this.#closed) {
      throw new Error(`El cliente MCP "${this.#config.name}" ya esta cerrado.`);
    }
    if (this.#ready && this.#processAlive() && !this.#failure) return;
    if (this.#recovering) return this.#recovering;

    this.#recovering = this.#recover().finally(() => {
      this.#recovering = undefined;
    });
    return this.#recovering;
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
   *
   * Si el transporte murio y `reconnect` esta activo, reinicia una vez y
   * reintenta. Los errores de la propia tool no se reintentan.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
    try {
      return await this.#callToolOnce(name, args);
    } catch (error) {
      // Solo se reconecta si el fallo dejo al proceso inservible; un timeout o
      // un error JSON-RPC del servidor no se arreglan reiniciando.
      if (!this.#config.reconnect || this.#closed) throw error;
      if (this.#processAlive() && !this.#failure) throw error;
      await this.ensureAlive();
      return this.#callToolOnce(name, args);
    }
  }

  /** Lista los recursos anunciados por el servidor. */
  async listResources(): Promise<McpResourceInfo[]> {
    const result = await this.#request<unknown>('resources/list', {});
    if (!isRecord(result) || !Array.isArray(result.resources)) {
      throw new Error(
        `El servidor MCP "${this.#config.name}" devolvio una lista de recursos invalida.`,
      );
    }
    const resources: McpResourceInfo[] = [];
    for (const item of result.resources) {
      if (!isRecord(item) || typeof item.uri !== 'string' || !item.uri.trim()) {
        log.warn('Recurso MCP ignorado: URI invalida', { server: this.#config.name });
        continue;
      }
      const info: McpResourceInfo = { uri: item.uri };
      if (typeof item.name === 'string') info.name = item.name;
      if (typeof item.description === 'string') info.description = item.description;
      if (typeof item.mimeType === 'string') info.mimeType = item.mimeType;
      resources.push(info);
    }
    return resources;
  }

  /** Lee un recurso y devuelve todos sus bloques de contenido. */
  async readResource(uri: string): Promise<McpResourceContent[]> {
    const target = uri.trim();
    if (!target) throw new Error('readResource: falta la URI del recurso.');

    const result = await this.#request<unknown>('resources/read', { uri: target });
    if (!isRecord(result) || !Array.isArray(result.contents)) {
      throw new Error(
        `El servidor MCP "${this.#config.name}" devolvio un contenido invalido para el recurso "${target}".`,
      );
    }
    const contents: McpResourceContent[] = [];
    for (const item of result.contents) {
      if (!isRecord(item) || typeof item.uri !== 'string' || !item.uri.trim()) {
        log.warn('Contenido MCP ignorado: URI invalida', {
          server: this.#config.name,
          recurso: target,
        });
        continue;
      }
      const content: McpResourceContent = { uri: item.uri };
      if (typeof item.mimeType === 'string') content.mimeType = item.mimeType;
      if (typeof item.text === 'string') content.text = item.text;
      if (typeof item.blob === 'string') content.blob = item.blob;
      if (content.text === undefined && content.blob === undefined) {
        log.warn('Contenido MCP ignorado: sin text ni blob', {
          server: this.#config.name,
          recurso: target,
        });
        continue;
      }
      contents.push(content);
    }
    if (contents.length === 0) {
      throw new Error(
        `El servidor MCP "${this.#config.name}" no devolvio contenido legible para el recurso "${target}".`,
      );
    }
    return contents;
  }

  /** Lista los prompts anunciados por el servidor. */
  async listPrompts(): Promise<McpPromptInfo[]> {
    const result = await this.#request<unknown>('prompts/list', {});
    if (!isRecord(result) || !Array.isArray(result.prompts)) {
      throw new Error(
        `El servidor MCP "${this.#config.name}" devolvio una lista de prompts invalida.`,
      );
    }
    const prompts: McpPromptInfo[] = [];
    for (const item of result.prompts) {
      if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) {
        log.warn('Prompt MCP ignorado: nombre invalido', { server: this.#config.name });
        continue;
      }
      const info: McpPromptInfo = { name: item.name };
      if (typeof item.description === 'string') info.description = item.description;
      if (Array.isArray(item.arguments)) {
        const args: McpPromptArgument[] = [];
        for (const arg of item.arguments) {
          if (!isRecord(arg) || typeof arg.name !== 'string' || !arg.name.trim()) continue;
          const parsed: McpPromptArgument = { name: arg.name };
          if (typeof arg.description === 'string') parsed.description = arg.description;
          if (typeof arg.required === 'boolean') parsed.required = arg.required;
          args.push(parsed);
        }
        info.arguments = args;
      }
      prompts.push(info);
    }
    return prompts;
  }

  /** Obtiene un prompt con sus argumentos ya sustituidos por el servidor. */
  async getPrompt(name: string, args: Record<string, string> = {}): Promise<McpPromptResult> {
    const target = name.trim();
    if (!target) throw new Error('getPrompt: falta el nombre del prompt.');

    const result = await this.#request<unknown>('prompts/get', {
      name: target,
      arguments: args,
    });
    if (!isRecord(result) || !Array.isArray(result.messages)) {
      throw new Error(
        `El servidor MCP "${this.#config.name}" devolvio un prompt invalido para "${target}".`,
      );
    }
    const messages: McpPromptMessage[] = [];
    for (const item of result.messages) {
      if (!isRecord(item) || typeof item.role !== 'string' || !('content' in item)) {
        log.warn('Mensaje MCP ignorado: formato invalido', {
          server: this.#config.name,
          prompt: target,
        });
        continue;
      }
      messages.push({ role: item.role, content: item.content });
    }
    const prompt: McpPromptResult = { messages };
    if (typeof result.description === 'string') prompt.description = result.description;
    return prompt;
  }

  /** Cierra el proceso. Es idempotente y no espera a que termine. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error(`El cliente MCP "${this.#config.name}" fue cerrado.`);
    this.#failure = error;
    this.#ready = false;
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

  async #callToolOnce(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
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

  async #recover(): Promise<void> {
    if (this.#closed) {
      throw new Error(`El cliente MCP "${this.#config.name}" ya esta cerrado.`);
    }
    if (this.#ready && this.#processAlive() && !this.#failure) return;
    if (this.#restarts >= MAX_RESTARTS) {
      throw new Error(
        `El servidor MCP "${this.#config.name}" no revive tras ${MAX_RESTARTS} reinicios.`,
      );
    }

    this.#restarts += 1;
    const attempt = this.#restarts;
    const delay = RESTART_DELAYS_MS[Math.min(attempt - 1, RESTART_DELAYS_MS.length - 1)] ?? 250;
    log.warn('Reiniciando servidor MCP', {
      server: this.#config.name,
      intento: attempt,
      esperaMs: delay,
    });
    await sleep(delay);
    if (this.#closed) {
      throw new Error(`El cliente MCP "${this.#config.name}" ya esta cerrado.`);
    }

    this.#discardChild();
    this.#failure = undefined;
    this.#ready = false;
    this.#buffer = '';

    // Un arranque en curso puede haber fallado ya; se espera y se prueba otra vez.
    if (this.#starting) {
      try {
        await this.#starting;
      } catch {
        // El error se sustituye por el del nuevo intento.
      }
      if (this.#ready && this.#processAlive() && !this.#failure) return;
    }

    this.#failure = undefined;
    this.#starting = this.#launch().finally(() => {
      this.#starting = undefined;
    });
    try {
      await this.#starting;
    } catch (error) {
      throw new Error(
        `No se pudo reiniciar el servidor MCP "${this.#config.name}" (intento ${attempt}/${MAX_RESTARTS}): ${errorMessage(error)}`,
      );
    }
  }

  #discardChild(): void {
    const child = this.#child;
    this.#child = undefined;
    if (!child) return;
    const error = new Error(`El cliente MCP "${this.#config.name}" se esta reiniciando.`);
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
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

  async #launch(): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.#config.command, this.#config.args ?? [], {
        env: { ...process.env, ...this.#config.env },
        windowsHide: true,
      });
    } catch (error) {
      const failure = new Error(
        `No se pudo arrancar el servidor MCP "${this.#config.name}": ${errorMessage(error)}`,
      );
      this.#failure = failure;
      throw failure;
    }
    this.#child = child;
    this.#buffer = '';
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
      if (!this.#closed) {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
  }

  #processAlive(): boolean {
    const child = this.#child;
    return child !== undefined && child.exitCode === null && child.signalCode === null;
  }

  #attach(child: ChildProcessWithoutNullStreams): void {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.#child !== child) return;
      this.#onStdout(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      if (this.#child !== child) return;
      const text = chunk.trim();
      if (text) {
        log.warn('stderr de servidor MCP', {
          server: this.#config.name,
          text: text.slice(0, 2000),
        });
      }
    });
    child.on('spawn', () => {
      if (this.#child !== child) return;
      const waiter = this.#startWaiter;
      this.#startWaiter = undefined;
      waiter?.resolve();
    });
    child.on('error', (error) => {
      if (this.#child !== child) return;
      this.#fail(
        new Error(`No se pudo arrancar el servidor MCP "${this.#config.name}": ${error.message}`),
      );
    });
    child.on('exit', (code, signal) => {
      if (this.#closed || this.#child !== child) return;
      const detail = signal ? `senal ${signal}` : `codigo ${code ?? 'desconocido'}`;
      this.#fail(new Error(`El proceso MCP "${this.#config.name}" termino (${detail}).`));
    });
    child.stdin.on('error', (error) => {
      if (this.#child !== child) return;
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
    this.#ready = false;
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
