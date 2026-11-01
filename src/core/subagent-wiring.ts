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
import { formatApproval } from '../approval-text.js';
import type { Config } from '../config.js';
import { Gate } from '../permissions.js';
import { createDelegateTool } from '../tools/delegate.js';
import type { AgentRunResult } from './agent.js';
import { PersonalAgent } from './agent.js';
import { SPECIALIST_READ_TOOLS, type SpecialistSpec, specialistAllowsCall } from './specialists.js';
import { SubagentPool, type SubagentPoolOptions } from './subagent.js';
import {
  type ChildHandle,
  type ChildSpec,
  createSubagentDeps,
  type SpecialistApprove,
  SUBAGENT_SAFE_TOOLS,
} from './subagent-runner.js';
import { THREAD_ALLOW_TOOLS } from './toolset.js';

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

/**
 * Acciones que la Gate del hilo deja pasar sin preguntar y que tocan a un
 * especialista con efectos (copia de las de createDaemonGate para computer; las
 * de memory/reminder solo leen, y el hilo deja libres esas herramientas enteras;
 * test: nunca mas libres que las del hilo).
 */
const EFFECTFUL_FREE_ACTIONS: readonly string[] = Object.freeze([
  'computer:screenshot',
  'computer:move',
  'memory:recall',
  'memory:list',
  'memory:get',
  'memory:timeline',
  'reminder:list',
]);

/**
 * Gate de un especialista CON efectos (notas, pc, tv, hogar). Las mismas reglas que la
 * del hilo para sus herramientas, pero mas estricta en todo lo demas:
 * - NUEVA: sin dbPath (no lee ni guarda «Siempre»), sin memo de aprobaciones del
 *   padre, sin fullControl, ventana de gracia 0 e importe maximo 0.
 * - Libre solo lo que el hilo ya deja libre (THREAD_ALLOW_TOOLS y las acciones de
 *   arriba) y que este en la lista del especialista; lo demas pregunta.
 * - Pregunta por `approve` (el chat del hilo, sin botones de alcance) y la
 *   pregunta empieza por «Especialista <nombre>:». Si la accion no cabe entera
 *   en la pregunta, o `approve` falla, se deniega.
 * - Todo lo que no es suyo sigue en `deny`.
 */
export function createEffectfulChildGate(
  options: ChildGateOptions,
  specialist: SpecialistSpec,
  approve: SpecialistApprove,
): Gate {
  const own = new Set(specialist.tools);
  return new Gate({
    allow: THREAD_ALLOW_TOOLS.filter(
      (name) => own.has(name) && specialist.actions?.[name] === undefined,
    ),
    allowActions: EFFECTFUL_FREE_ACTIONS.filter((pair) => {
      const [tool, action] = pair.split(':') as [string, string];
      return own.has(tool) && (specialist.actions?.[tool]?.includes(action) ?? true);
    }),
    deny: SUBAGENT_DENIED_TOOLS.filter((name) => !own.has(name)),
    protectedPaths: options.protectedPaths ?? [],
    secretPaths: options.secretPaths ?? [],
    maxAmountCents: 0,
    grantWindowMs: 0,
    approver: async (call, reason) => {
      // Lo que no esta en su lista no se pregunta: se deniega (y el envoltorio del
      // toolset tampoco lo ejecutaria).
      if (!specialistAllowsCall(specialist, call.tool, call.args)) return false;
      const approval = formatApproval(call, reason);
      if (!approval.complete) return false;
      try {
        return (await approve(`Especialista ${specialist.title}: ${approval.question}`)) === true;
      } catch {
        return false;
      }
    },
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
    const gate =
      spec.specialist?.effectful && spec.approve
        ? createEffectfulChildGate(options, spec.specialist, spec.approve)
        : createChildGate(options, spec.specialist);
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
  forThread: (threadTools: () => readonly AgentTool[], approve?: SpecialistApprove) => AgentTool;
} {
  const deps = createSubagentDeps({
    makeChild: createChildFactory(options),
    parentTools: options.parentTools,
  });
  const pool = new SubagentPool(deps, options.pool);
  // depthOf = 0: solo el agente principal tiene esta tool; el hijo jamas la recibe.
  const tool = createDelegateTool(pool, () => 0) as unknown as AgentTool;
  const forThread = (threadTools: () => readonly AgentTool[], approve?: SpecialistApprove) =>
    createDelegateTool(pool, () => 0, {
      parentTools: threadTools,
      ...(approve ? { approve } : {}),
    }) as unknown as AgentTool;
  return { tool, pool, forThread };
}
