/**
 * F9: Asistenta como servidor MCP de SOLO lectura (`pa mcp serve`, stdio).
 *
 * Otras herramientas (Claude Desktop/Code, Cursor…) pueden consultar la
 * memoria, las sesiones y los objetivos del chat privado del dueño. No hay
 * ninguna tool que escriba, y todo lo que sale pasa por el filtro de secretos
 * del registro. Solo arranca si Nico lo ejecuta a mano.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export const MCP_SERVER_NAME = 'asistenta';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_RESULTS = 20;
const MAX_TEXT = 20_000;

export interface ReadOnlyMcpDeps {
  /** Memoria del chat del dueño: (consulta, límite) → entradas. */
  memorySearch: (query: string, limit: number) => Array<{ date: string; text: string }>;
  /** Sesiones pasadas del chat del dueño. */
  sessionSearch: (
    query: string,
    limit: number,
  ) => Array<{ title: string; summary: string; snippet: string; at: number }>;
  /** Objetivos del chat del dueño. */
  goals: () => Array<{ title: string; status: string; cadence: string | null }>;
  /** Filtro de secretos (scrubLogText). */
  scrub: (text: string) => string;
  version?: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (deps: ReadOnlyMcpDeps, args: Record<string, unknown>) => string;
}

const queryArgs = {
  type: 'object',
  properties: {
    consulta: { type: 'string', description: 'Texto a buscar' },
    limite: { type: 'integer', minimum: 1, maximum: MAX_RESULTS },
  },
  required: ['consulta'],
  additionalProperties: false,
};

function readQuery(args: Record<string, unknown>): { q: string; limit: number } {
  const q = typeof args.consulta === 'string' ? args.consulta.trim().slice(0, 500) : '';
  if (!q) throw new McpToolError('Falta «consulta».');
  const n = Number(args.limite ?? 5);
  const limit = Number.isFinite(n) ? Math.max(1, Math.min(MAX_RESULTS, Math.floor(n))) : 5;
  return { q, limit };
}

class McpToolError extends Error {}

/** Las únicas tools que existen. Todas leen; ninguna escribe. */
export const READ_ONLY_TOOLS: readonly ToolDef[] = [
  {
    name: 'memoria_buscar',
    description: 'Busca en la memoria de Asistenta (chat privado del dueño). Solo lectura.',
    inputSchema: queryArgs,
    run: (deps, args) => {
      const { q, limit } = readQuery(args);
      const hits = deps.memorySearch(q, limit);
      return hits.length
        ? hits.map((h) => `- [${h.date}] ${h.text}`).join('\n')
        : 'Nada en memoria para esa búsqueda.';
    },
  },
  {
    name: 'sesiones_buscar',
    description: 'Busca en conversaciones pasadas (chat privado del dueño). Solo lectura.',
    inputSchema: queryArgs,
    run: (deps, args) => {
      const { q, limit } = readQuery(args);
      const hits = deps.sessionSearch(q, limit);
      return hits.length
        ? hits
            .map(
              (h) =>
                `- ${new Date(h.at).toISOString().slice(0, 10)} ${h.title}: ${h.summary || h.snippet}`,
            )
            .join('\n')
        : 'Ninguna sesión casa con esa búsqueda.';
    },
  },
  {
    name: 'objetivos_listar',
    description: 'Lista los objetivos del dueño con su estado. Solo lectura.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (deps) => {
      const goals = deps.goals().slice(0, 100);
      return goals.length
        ? goals
            .map((g) => `- ${g.title} (${g.status}${g.cadence ? `, ${g.cadence}` : ''})`)
            .join('\n')
        : 'No hay objetivos.';
    },
  },
];

type JsonRpcId = string | number | null;
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

const reply = (id: JsonRpcId, result: unknown) => ({ jsonrpc: '2.0', id, result });
const fail = (id: JsonRpcId, code: number, message: string) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

/**
 * Atiende un mensaje JSON-RPC. Devuelve la respuesta, o null para
 * notificaciones (sin id).
 */
export function handleMcpMessage(deps: ReadOnlyMcpDeps, raw: unknown): object | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(null, -32600, 'Petición no válida');
  }
  const msg = raw as JsonRpcMessage;
  const isNotification = msg.id === undefined;
  const id: JsonRpcId = msg.id ?? null;
  const params =
    msg.params && typeof msg.params === 'object' ? (msg.params as Record<string, unknown>) : {};
  if (typeof msg.method !== 'string') {
    return isNotification ? null : fail(id, -32600, 'Petición no válida');
  }
  if (isNotification) return null;
  switch (msg.method) {
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return reply(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, version: deps.version ?? '0' },
        instructions: 'Asistenta en solo lectura: memoria, sesiones y objetivos del dueño.',
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, {
        tools: READ_ONLY_TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const tool = READ_ONLY_TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(id, -32602, `Tool desconocida: ${String(params.name)}`);
      const args =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const text = deps.scrub(tool.run(deps, args)).slice(0, MAX_TEXT);
        return reply(id, { content: [{ type: 'text', text }], isError: false });
      } catch (err) {
        const text = err instanceof McpToolError ? err.message : 'Error interno al leer los datos.';
        return reply(id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `Método no soportado: ${msg.method}`);
  }
}

/** Bucle stdio: un mensaje JSON por línea, respuestas por línea. */
export async function serveMcpStdio(
  deps: ReadOnlyMcpDeps,
  input: Readable,
  output: Writable,
): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let out: object | null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      out = Array.isArray(parsed)
        ? fail(null, -32600, 'Lotes no soportados')
        : handleMcpMessage(deps, parsed);
    } catch {
      out = fail(null, -32700, 'JSON no válido');
    }
    if (out) output.write(`${JSON.stringify(out)}\n`);
  }
}
