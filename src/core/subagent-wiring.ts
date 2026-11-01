/**
 * Cableado de la tool `delegate`: Gate propia del hijo, fabrica de hijos reales
 * (`PersonalAgent`) y el pool. Vive aparte de cli.ts para poder probarlo sin
 * arrancar canales.
 *
 * El hijo NO hereda nada del padre salvo la lista de herramientas de solo lectura
 * ya filtrada: su Gate es nueva (sin memo de aprobaciones, sin scopes, sin
 * grants, sin dbPath), no tiene approver (todo lo que pediria aprobacion se
 * rechaza: falla cerrado) y lista como `deny` toda herramienta con efectos.
 * Los permisos del padre no se amplian jamas: la Gate del padre no se toca.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Config } from '../config.js';
import { Gate } from '../permissions.js';
import { createDelegateTool } from '../tools/delegate.js';
import type { AgentRunResult } from './agent.js';
import { PersonalAgent } from './agent.js';
import { SPECIALIST_READ_TOOLS, type SpecialistSpec } from './specialists.js';
import { SubagentPool, type SubagentPoolOptions } from './subagent.js';
import {
  type ChildHandle,
  type ChildSpec,
  createSubagentDeps,
  SUBAGENT_SAFE_TOOLS,
} from './subagent-runner.js';

/** Herramientas con efectos que el hijo nunca puede usar, ni con aprobacion. */
export const SUBAGENT_DENIED_TOOLS: readonly string[] = Object.freeze([
  'write',
  'shell',
  'browser',
  'computer',
  'commerce',
  'book',
  'mail',
  'tv',
  'iphone',
  'media',
  'memory',
  'reminder',
  'agenda',
  'objetivo',
  'gestion',
  'factory',
  'opengym',
  'preguntar',
  'ask',
  'delegate',
  'cargar_herramienta',
]);

export interface ChildGateOptions {
  protectedPaths?: string[];
  secretPaths?: string[];
}

/**
 * Gate del hijo. Sin `approver`: `ask` termina en deny. Sin `dbPath`: no lee los
 * "Siempre" del padre. Sin fullControl. Importe maximo 0.
 *
 * Con un especialista sin efectos: permite sus herramientas sin acciones que
 * esten en SUBAGENT_SAFE_TOOLS y, de las acotadas por acciones, solo esos pares
 * `herramienta:accion`. Todo lo demas sigue en `deny` o acaba en deny (sin approver).
 */
export function createChildGate(options: ChildGateOptions = {}, specialist?: SpecialistSpec): Gate {
  const allow = specialist
    ? specialist.tools.filter(
        (name) =>
          specialist.actions?.[name] === undefined &&
          (SUBAGENT_SAFE_TOOLS.includes(name) || SPECIALIST_READ_TOOLS.includes(name)),
      )
    : [...SUBAGENT_SAFE_TOOLS];
  const allowActions = specialist
    ? Object.entries(specialist.actions ?? {}).flatMap(([tool, actions]) =>
        specialist.tools.includes(tool) ? actions.map((action) => `${tool}:${action}`) : [],
      )
    : [];
  return new Gate({
    allow,
    ...(allowActions.length > 0 ? { allowActions } : {}),
    deny: [...SUBAGENT_DENIED_TOOLS],
    protectedPaths: options.protectedPaths ?? [],
    secretPaths: options.secretPaths ?? [],
    maxAmountCents: 0,
    grantWindowMs: 0,
  });
}

/** Lo minimo que se usa de un agente hijo (permite un doble en pruebas). */
export interface ChildAgent {
  run(prompt: string): Promise<AgentRunResult>;
  abort(scope?: 'internal' | 'external'): void;
}

export type CreateChildAgent = (
  config: Config,
  tools: AgentTool[],
  gate: Gate,
  actor: string,
  opts: { sessionId: string; desktop: false; iterationBudget: { max: number } },
) => Promise<ChildAgent>;

export interface ChildFactoryOptions extends ChildGateOptions {
  config: Config;
  createAgent?: CreateChildAgent;
}

let childSeq = 0;

/** `makeChild` real: historial nuevo, Gate propia y toolset ya aislado por spec. */
export function createChildFactory(
  options: ChildFactoryOptions,
): (spec: ChildSpec) => Promise<ChildHandle> {
  const create: CreateChildAgent =
    options.createAgent ??
    ((config, tools, gate, actor, opts) => PersonalAgent.create(config, tools, gate, actor, opts));
  return async (spec) => {
    const gate = createChildGate(options, spec.specialist);
    const config: Config = {
      ...options.config,
      maxToolCalls: Math.max(0, Math.min(spec.maxToolCalls, options.config.maxToolCalls)),
    };
    const agent = await create(config, spec.toolset, gate, 'subagent', {
      sessionId: `subagent-${Date.now()}-${childSeq++}`,
      desktop: false,
      iterationBudget: { max: config.maxToolCalls },
    });
    return {
      run: async (prompt) => {
        const r = await agent.run(prompt);
        return { text: r.text, toolCalls: r.toolCalls, error: r.error };
      },
      abort: () => agent.abort('external'),
    };
  };
}

export interface DelegateWiringOptions extends ChildFactoryOptions {
  /** Herramientas del padre; el hijo solo recibe las de solo lectura. */
  parentTools: () => readonly AgentTool[];
  pool?: SubagentPoolOptions;
}

/**
 * La tool `delegate` lista para registrar en el toolset del agente de nivel 0.
 * `forThread(tools)` da otra `delegate` sobre el MISMO pool (los limites valen
 * para todos los hilos) cuyos hijos eligen de las herramientas de ESE hilo.
 */
export function createDelegateWiring(options: DelegateWiringOptions): {
  tool: AgentTool;
  pool: SubagentPool;
  forThread: (threadTools: () => readonly AgentTool[]) => AgentTool;
} {
  const deps = createSubagentDeps({
    makeChild: createChildFactory(options),
    parentTools: options.parentTools,
  });
  const pool = new SubagentPool(deps, options.pool);
  // depthOf = 0: solo el agente principal tiene esta tool; el hijo jamas la recibe.
  const tool = createDelegateTool(pool, () => 0) as unknown as AgentTool;
  const forThread = (threadTools: () => readonly AgentTool[]) =>
    createDelegateTool(pool, () => 0, { parentTools: threadTools }) as unknown as AgentTool;
  return { tool, pool, forThread };
}
