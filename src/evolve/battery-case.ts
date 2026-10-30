// Corre UN caso de la batería contra el código de esta carpeta, con datos desechables y
// sin cuentas reales, y devuelve la traza que puntúa battery-judge.ts. Es el evaluador por
// defecto de PA_EVOLVE_BATTERY (lo lanza scripts/evolve-battery-case.mjs).
//
// Qué tiene el agente aquí: memoria y recordatorios de verdad, pero en una carpeta temporal
// que se borra al acabar; el resto de herramientas que tocan el mundo (correo, navegador,
// web, shell, ficheros, compras, PC) existen con su nombre pero no hacen nada: devuelven
// «no disponible» y quedan apuntadas en la traza. Toda petición de aprobación se cuenta y
// se DENIEGA: una prueba nunca ejecuta nada que necesite el «sí» de Nico.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Cron } from 'croner';
import { Type } from 'typebox';
import type { Config } from '../config.js';
import { PersonalAgent } from '../core/agent.js';
import { Store } from '../db.js';
import { MemoryStore } from '../memory.js';
import { type Decision, Gate, type ToolCall as GateCall } from '../permissions.js';
import { createMemoryTool } from '../tools/memory.js';
import { createReminderTool } from '../tools/reminder.js';
import type { BatteryCase, Scheduled, ToolCall, Trace } from './battery-judge.js';

/**
 * Herramientas reales del asistente (mismos nombres) que en la batería existen pero no tocan
 * nada: sin red, sin cuentas, sin PC. El modelo las ve igual que en producción.
 */
export const INERT_TOOLS = [
  'web',
  'fetch',
  'download',
  'browser',
  'shell',
  'computer',
  'renfe',
] as const;

/** read/write/list de verdad, pero encerradas en el espacio de trabajo de la carpeta temporal. */
export const WORKSPACE_TOOLS = ['read', 'write', 'list'] as const;

const INERT_TEXT = 'No disponible en la batería de pruebas: aquí no hay cuentas, red ni PC reales.';

export interface CaseRunDeps {
  config: Config;
  /** Carpeta de datos; sin ella se crea una temporal y se borra al acabar. */
  stateDir?: string;
  now?: () => number;
}

function callName(tool: string, args: unknown): string {
  const a = (args as { action?: unknown } | null)?.action;
  return typeof a === 'string' && /^[\w-]+$/.test(a) ? `${tool}.${a}` : tool;
}

function argsText(args: unknown): string {
  try {
    return JSON.stringify(args ?? {}).slice(0, 2000);
  } catch {
    return '';
  }
}

function inertTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `${name} (sin acceso real en la batería de pruebas)`,
    parameters: Type.Object(
      { action: Type.Optional(Type.String()) },
      { additionalProperties: true },
    ),
    execute: async () => {
      throw new Error(INERT_TEXT);
    },
  } as unknown as AgentTool;
}

/** Una ruta del modelo dentro del espacio de trabajo, o error claro si se sale. */
function inside(root: string, raw: string): string {
  const p = resolve(root, raw.replace(/^~(?=$|[\\/])/, root));
  const rel = relative(root, p);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error(`la ruta se sale del espacio de trabajo: ${raw}`);
  return p;
}

const text = (t: string) => ({ content: [{ type: 'text', text: t }], details: {} });

/**
 * read/write/list con los nombres y parámetros de las reales (tools/fs.ts), pero sobre
 * <carpeta temporal>/espacio: el caso puede crear y leer ficheros sin tocar el código medido.
 */
export function workspaceTools(root: string): AgentTool[] {
  mkdirSync(root, { recursive: true });
  const read = {
    name: 'read',
    label: 'Read',
    description: 'Lee un fichero de texto del espacio de trabajo.',
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    execute: async (_id: string, a: { path: string; offset?: number; limit?: number }) => {
      const lines = readFileSync(inside(root, a.path), 'utf8').split('\n');
      const from = Math.max(1, Math.floor(a.offset ?? 1));
      const to = a.limit ? from - 1 + Math.floor(a.limit) : lines.length;
      return text(
        lines
          .slice(from - 1, to)
          .join('\n')
          .slice(0, 22_000),
      );
    },
  };
  const write = {
    name: 'write',
    label: 'Write',
    description: 'Escribe un fichero de texto en el espacio de trabajo (crea las carpetas).',
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id: string, a: { path: string; content: string }) => {
      const p = inside(root, a.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, a.content, 'utf8');
      return text(`Wrote ${a.content.length} bytes to ${a.path}`);
    },
  };
  const list = {
    name: 'list',
    label: 'List',
    description: 'Lista una carpeta del espacio de trabajo.',
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    execute: async (_id: string, a: { path?: string }) => {
      const items = readdirSync(inside(root, a.path ?? '.'), { withFileTypes: true })
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
        .sort();
      return text(items.join('\n') || '(empty)');
    },
  };
  return [read, write, list] as unknown as AgentTool[];
}

/** Envuelve una herramienta para apuntar cada ejecución (nombre, argumentos, si fue bien). */
function recorded(tool: AgentTool, calls: ToolCall[]): AgentTool {
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    execute: (async (...a: Parameters<AgentTool['execute']>) => {
      const entry: ToolCall = { name: callName(tool.name, a[1]), args: argsText(a[1]) };
      calls.push(entry);
      try {
        const out = await execute(...a);
        entry.ok = !(out as { isError?: boolean } | undefined)?.isError;
        return out;
      } catch (err) {
        entry.ok = false;
        throw err;
      }
    }) as AgentTool['execute'],
  };
}

/** Gate de producción que además apunta lo que deniega: una llamada denegada también es un intento. */
class TracingGate extends Gate {
  readonly calls: ToolCall[];

  constructor(dbPath: string, calls: ToolCall[], asked: { n: number }) {
    super({
      dbPath,
      grantWindowMs: 0,
      // read/write/list solo ven la carpeta temporal (workspaceTools): no hay nada que aprobar.
      allow: ['memory', 'reminder', ...WORKSPACE_TOOLS],
      approver: () => {
        asked.n++;
        return false;
      },
    });
    this.calls = calls;
  }

  override async check(sessionId: string, call: GateCall): Promise<Decision> {
    const decision = await super.check(sessionId, call);
    if (decision.verdict === 'deny')
      this.calls.push({
        name: callName(call.tool, call.args),
        args: argsText(call.args),
        ok: false,
      });
    return decision;
  }
}

/** Recordatorios que dejó el caso, leídos de la base (no de lo que diga el modelo). */
function scheduledFrom(store: Store, now: number): Scheduled[] {
  const tz = process.env.PA_TIMEZONE || 'Europe/Madrid';
  return store
    .listRoutines()
    .filter((r) => r.schedule)
    .map((r) => {
      const expr = r.schedule as string;
      if (!r.name.startsWith('recordatorio-1')) return { kind: 'cron', expr, tz };
      let fireAtIso: string | undefined;
      try {
        fireAtIso = new Cron(expr, { paused: true, timezone: tz })
          .nextRun(new Date(now))
          ?.toISOString();
      } catch {
        fireAtIso = undefined;
      }
      return { kind: 'once', expr, tz, fireAtIso };
    });
}

const ENV_ERROR =
  /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|\b(429|5\d\d)\b|rate.?limit|overloaded/i;

export async function runBatteryCase(c: BatteryCase, deps: CaseRunDeps): Promise<Trace> {
  const own = deps.stateDir === undefined;
  const dir = deps.stateDir ?? mkdtempSync(join(tmpdir(), 'pa-battery-'));
  const now = deps.now ?? (() => Date.now());
  const calls: ToolCall[] = [];
  const asked = { n: 0 };
  const store = new Store(join(dir, 'pa.db'));
  try {
    const scope = `bateria:${c.id}`;
    const memory = new MemoryStore(join(dir, 'memory'));
    const tools: AgentTool[] = [
      createMemoryTool(memory, () => scope) as unknown as AgentTool,
      createReminderTool({
        store,
        scopeOf: () => scope,
        sync: () => {},
        now,
      }) as unknown as AgentTool,
      ...workspaceTools(join(dir, 'espacio')),
      ...INERT_TOOLS.map(inertTool),
    ].map((t) => recorded(t, calls));
    const gate = new TracingGate(join(dir, 'approvals.db'), calls, asked);
    const agent = await PersonalAgent.create(deps.config, tools, gate, 'bateria', {
      desktop: false,
      sessionId: scope,
    });
    const r = await agent.run(c.prompt);
    const err = r.error ?? '';
    return {
      reply: r.text ?? '',
      toolCalls: calls,
      approvalsAsked: asked.n,
      writes: memory.all(scope).map((e) => e.text),
      scheduled: scheduledFrom(store, now()),
      timedOut: /timeout|timed out/i.test(r.stopReason) || undefined,
      envError: (!!err && ENV_ERROR.test(err)) || undefined,
    };
  } finally {
    store.close?.();
    if (own) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Lee el caso de PA_BATTERY_CASE; lanza si no es un caso con id y prompt. */
export function caseFromEnv(env: NodeJS.ProcessEnv = process.env): BatteryCase {
  let c: Partial<BatteryCase> | null = null;
  try {
    c = JSON.parse(env.PA_BATTERY_CASE ?? '') as Partial<BatteryCase>;
  } catch {
    c = null;
  }
  if (!c || typeof c.id !== 'string' || typeof c.prompt !== 'string' || !c.prompt.trim())
    throw new Error('PA_BATTERY_CASE no es un caso válido (hace falta id y prompt).');
  return { machine: {}, ...c } as BatteryCase;
}
