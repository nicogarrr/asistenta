import type {
  AssistantMessage,
  AssistantMessageEventStream,
  JsonObject,
  Message,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  Tool,
  ToolCall,
  TranscriptContext,
  Usage,
} from '@earendil-works/pi-ai';
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
} from '@earendil-works/pi-ai';
import { log } from '../log.js';

/**
 * opencode-local: asistenta habla con un `opencode serve` local (127.0.0.1).
 *
 * Por que existe: el free tier de OpenCode Zen solo sirve llamadas que salen
 * del cliente real de OpenCode ("can only be used from within OpenCode",
 * medido: 403 FreeTierError por API directa con key valida, 200 dentro del
 * CLI/serve con la MISMA key). Montando `opencode serve` en la maquina del
 * usuario, asistenta usa los modelos -free de Zen de forma legitima.
 *
 * Restricciones medidas del free tier (2026-10-15, llamadas reales):
 * - Custom tools de opencode -> 403 FreeTierError. Por eso las tools de
 *   asistenta NO se registran en opencode: viajan serializadas en el prompt
 *   y el modelo pide la llamada con una linea JSON {"tool":...,"args":{}}.
 * - Agente con prompt propio y campo `system` por llamada: permitido.
 * - El resultado de una tool hay que darlo en un turno auto-contenido: si se
 *   encadena en la misma sesion de opencode, el modelo repite la llamada en
 *   bucle (medido con deepseek-v4.1-flash-free y space-bunny-free). Como pi-ai
 *   nos da el transcript completo en cada llamada, cada peticion a serve es
 *   una sesion NUEVA con todo el historial serializado: sin estado server-side.
 */

export interface OpenCodeLocalConfig {
  /** URL base del opencode serve local, p.ej. http://127.0.0.1:4096 */
  url: string;
  /** Modelo Zen, p.ej. deepseek-v4.1-flash-free */
  model: string;
  /** Agente de opencode.json a usar (prompt minimal propio de asistenta). */
  agent: string;
  /** Presupuesto total por llamada (crear sesion + generacion + polling). */
  timeoutMs: number;
}

export const DEFAULT_OPENCODE_LOCAL: Omit<OpenCodeLocalConfig, 'url' | 'model'> = {
  agent: 'asistenta',
  timeoutMs: 120_000,
};

interface OcPart {
  type: string;
  text?: string;
}
interface OcMessage {
  info: { role?: string; finish?: string | null; error?: { data?: { message?: string } } };
  parts?: OcPart[];
}

async function ocFetch<T>(
  cfg: OpenCodeLocalConfig,
  path: string,
  init?: RequestInit,
  userSignal?: AbortSignal,
): Promise<T> {
  const res = await fetch(cfg.url.replace(/\/$/, '') + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    signal: AbortSignal.any(
      [AbortSignal.timeout(cfg.timeoutMs), ...(userSignal ? [userSignal] : [])].filter(Boolean),
    ),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`opencode serve ${path}: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Contrato de tools por prompt (ver cabecera): linea JSON unica, sin markdown. */
export function renderToolContract(tools: Tool[]): string {
  if (tools.length === 0) return '';
  const specs = tools
    .map((t) => `- ${t.name}(${renderParams(t)}): ${t.description ?? ''}`)
    .join('\n');
  return [
    'TIENES HERRAMIENTAS. Nadie mas las ejecuta: tu solo pides la llamada.',
    'Para pedir UNA herramienta responde SOLO con una linea JSON: {"tool":"nombre","args":{...}}',
    'sin markdown, sin texto extra. Si no hace falta herramienta, responde en texto normal.',
    'Cuando en el historial veas "RESULTADO <tool>: ..." ya tienes el dato: respondelo, no repitas la llamada.',
    'Herramientas disponibles:',
    specs,
  ].join('\n');
}

function renderParams(t: Tool): string {
  const schema = (
    t as { parameters?: { properties?: Record<string, unknown>; required?: string[] } }
  ).parameters;
  if (!schema?.properties) return '';
  const req = new Set(schema.required ?? []);
  return Object.entries(schema.properties)
    .map(([name, p]) => {
      const type = (p as { type?: string }).type ?? 'any';
      return `${name}${req.has(name) ? '' : '?'}: ${type}`;
    })
    .join(', ');
}

/** Serializa el transcript pi-ai completo como UN mensaje de usuario auto-contenido. */
export function renderTranscript(messages: Message[]): string {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue; // el system prompt va en el campo `system`
    if (m.role === 'user') {
      out.push('USUARIO: ' + textOf(m.content));
    } else if (m.role === 'assistant') {
      for (const block of m.content) {
        if (block.type === 'text') out.push('ASISTENTA: ' + block.text);
        else if (block.type === 'toolCall')
          out.push(
            'ASISTENTA (llamada): ' + JSON.stringify({ tool: block.name, args: block.arguments }),
          );
      }
    } else if (m.role === 'toolResult') {
      const body = m.content.map((c) => (c.type === 'text' ? c.text : '[imagen]')).join('\n');
      out.push(`RESULTADO ${m.toolName}${m.isError ? ' (ERROR)' : ''}: ${body}`);
    }
  }
  return out.join('\n\n');
}

function textOf(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content.map((c) => (c.type === 'text' ? (c.text ?? '') : '[imagen]')).join('\n');
}

export interface ParsedReply {
  kind: 'text' | 'toolCall';
  text?: string;
  toolCall?: { name: string; arguments: JsonObject };
}

/** Parser del contrato: primera linea JSON {"tool":...} = llamada; si no, texto. */
export function parseReply(raw: string, knownTools: Set<string>): ParsedReply {
  const trimmed = raw.trim();
  const firstLine = trimmed.split('\n', 1)[0]?.trim() ?? '';
  if (firstLine.startsWith('{') && firstLine.endsWith('}')) {
    try {
      const obj = JSON.parse(firstLine) as { tool?: unknown; args?: unknown };
      if (
        typeof obj.tool === 'string' &&
        knownTools.has(obj.tool) &&
        (obj.args === undefined || (typeof obj.args === 'object' && obj.args !== null))
      ) {
        return {
          kind: 'toolCall',
          toolCall: { name: obj.tool, arguments: (obj.args as JsonObject) ?? {} },
        };
      }
    } catch {
      // no es JSON valido: se trata como texto (nunca se inventa una llamada)
    }
  }
  return { kind: 'text', text: trimmed };
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Espera a que el mensaje assistant termine (finish o error) con polling acotado. */
async function waitReply(
  cfg: OpenCodeLocalConfig,
  sessionId: string,
  userSignal?: AbortSignal,
): Promise<{ text: string; tokens: number }> {
  const deadline = Date.now() + cfg.timeoutMs;
  for (;;) {
    const msgs = await ocFetch<OcMessage[]>(
      cfg,
      `/session/${sessionId}/message`,
      undefined,
      userSignal,
    );
    for (const m of msgs) {
      const i = m.info;
      if (i.role !== 'assistant') continue;
      if (i.error)
        throw new Error(`opencode serve: ${i.error.data?.message ?? 'error desconocido'}`);
      if (i.finish) {
        const text = (m.parts ?? [])
          .filter((p) => p.type === 'text')
          .map((p) => p.text ?? '')
          .join('');
        return { text, tokens: 0 };
      }
    }
    if (Date.now() > deadline)
      throw new Error(`opencode serve: timeout ${cfg.timeoutMs}ms esperando respuesta`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * StreamFunction compatible con pi-ai: una llamada = una sesion serve nueva
 * (auto-contenida, ver cabecera). No hay streaming real en v1: se emite el
 * texto completo como un unico delta al recibirlo (la interfaz lo admite).
 */
export function createOpenCodeLocalStream(
  cfg: OpenCodeLocalConfig,
): StreamFunction<'openai-completions', SimpleStreamOptions> {
  return (
    model: Model<'openai-completions'>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const events = createAssistantMessageEventStream();
    const userSignal = (options as { signal?: AbortSignal } | undefined)?.signal;
    const tools: Tool[] = getCurrentTools(context.messages);
    void (async () => {
      const partial: AssistantMessage = {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: ZERO_USAGE,
        stopReason: 'pending',
        timestamp: Date.now(),
      };
      events.push({ type: 'start', partial });
      try {
        const systemBase = getCurrentSystemPrompt(context.messages);
        const system = [systemBase, renderToolContract(tools)].filter(Boolean).join('\n\n');
        const userText = renderTranscript(context.messages);
        const session = await ocFetch<{ id: string }>(cfg, '/session', {
          method: 'POST',
          body: '{}',
        });
        await ocFetch(
          cfg,
          `/session/${session.id}/message`,
          {
            method: 'POST',
            body: JSON.stringify({
              model: { providerID: 'opencode', modelID: cfg.model },
              agent: cfg.agent,
              system,
              parts: [{ type: 'text', text: userText }],
            }),
          },
          userSignal,
        );
        const reply = await waitReply(cfg, session.id, userSignal);
        const parsed = parseReply(reply.text, new Set(tools.map((t) => t.name)));
        let done: AssistantMessage;
        if (parsed.kind === 'toolCall' && parsed.toolCall) {
          const call: ToolCall = {
            type: 'toolCall',
            id: `ocl-${Date.now()}`,
            name: parsed.toolCall.name,
            arguments: parsed.toolCall.arguments,
          };
          events.push({ type: 'toolcall_start', contentIndex: 0, partial });
          events.push({ type: 'toolcall_end', contentIndex: 0, toolCall: call, partial });
          done = { ...partial, content: [call], stopReason: 'toolUse', timestamp: Date.now() };
          events.push({ type: 'done', reason: 'toolUse', message: done });
        } else {
          const text = parsed.text ?? '';
          events.push({ type: 'text_start', contentIndex: 0, partial });
          events.push({ type: 'text_delta', contentIndex: 0, delta: text, partial });
          events.push({ type: 'text_end', contentIndex: 0, content: text, partial });
          done = {
            ...partial,
            content: text ? [{ type: 'text', text }] : [],
            stopReason: 'stop',
            timestamp: Date.now(),
          };
          events.push({ type: 'done', reason: 'stop', message: done });
        }
        events.end(done);
      } catch (err) {
        const failed: AssistantMessage = {
          ...partial,
          stopReason: 'error',
          errorMessage: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        };
        events.push({ type: 'error', reason: 'error', error: failed });
        events.end(failed);
      }
      log.info('opencode-local reply', { model: cfg.model });
    })();
    return events;
  };
}
