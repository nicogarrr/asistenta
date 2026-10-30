// Corre UN caso de la batería contra el código de esta carpeta, con datos desechables y
// sin cuentas reales, y devuelve la traza que puntúa battery-judge.ts. Es el evaluador por
// defecto de PA_EVOLVE_BATTERY (lo lanza scripts/evolve-battery-case.mjs).
//
// Qué tiene el agente aquí: memoria y recordatorios de verdad, pero en una carpeta temporal
// que se borra al acabar; el resto de herramientas que tocan el mundo (correo, navegador,
// web, shell, ficheros, compras, PC) existen con su nombre pero no hacen nada: devuelven
// «no disponible» y quedan apuntadas en la traza. Toda petición de aprobación se cuenta y
// se DENIEGA: una prueba nunca ejecuta nada que necesite el «sí» de Nico.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** Herramientas que en la batería existen pero no tocan nada fuera de la carpeta temporal. */
export const INERT_TOOLS = [
  'mail',
  'browser',
  'fetch',
  'web_search',
  'download',
  'shell',
  'fs',
  'calendar',
  'renfe',
  'computer',
] as const;

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
      allow: ['memory', 'reminder'],
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
