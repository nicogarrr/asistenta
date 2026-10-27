/**
 * Ejecutor real de subagentes: roles EXPLORER / PLANNER / IMPLEMENTER y
 * aislamiento comprobable.
 *
 * `SubagentPool` solo decide profundidad, concurrencia y timeout; el contrato de
 * aislamiento (historial nuevo, sin herramientas con efectos, sin aprobaciones
 * heredadas) lo tiene que cumplir quien construye el hijo. Este modulo lo
 * cumple por construccion y fail-closed:
 *
 * - Cada ejecucion crea un hijo NUEVO (`makeChild`) y solo recibe el prompt de la
 *   tarea (sin transcript del padre). Que la fabrica no reutilice historial es
 *   contrato de la fabrica y lo prueba su test; el toolset y el tope de llamadas
 *   si se imponen aqui por construccion (`isolateTools`).
 * - El toolset del hijo es la interseccion de lo pedido, lo que permite el rol y
 *   una lista cerrada de herramientas de solo lectura. Una herramienta con
 *   efectos (write, shell, browser...) se descarta aunque el modelo la pida.
 * - Aunque alguien la colara en el array, `isolateTools` vuelve a filtrar y
 *   envuelve `execute` para rechazar cualquier nombre fuera de la lista y
 *   cualquier llamada tras abortar la senal.
 * - IMPLEMENTER NO escribe: devuelve el cambio propuesto como texto/diff y el
 *   padre (con sus aprobaciones) lo aplica. Un hijo con escritura necesitaria
 *   su propio permiso por accion y worktree aislado; eso queda fuera a proposito.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { SubagentBudget, SubagentDeps, SubagentRunRequest } from './subagent.js';

export const SUBAGENT_ROLES = ['explorer', 'planner', 'implementer'] as const;
export type SubagentRole = (typeof SUBAGENT_ROLES)[number];

/** Unicas herramientas que un hijo puede tener jamas: lectura y busqueda. */
export const SUBAGENT_SAFE_TOOLS: readonly string[] = Object.freeze([
  'read',
  'list',
  'fetch',
  'web',
]);

interface RoleSpec {
  tools: readonly string[];
  prompt: string;
}

export const SUBAGENT_ROLE_SPECS: Readonly<Record<SubagentRole, RoleSpec>> = Object.freeze({
  explorer: {
    tools: ['read', 'list', 'fetch', 'web'],
    prompt:
      'Rol EXPLORER. Solo lees y buscas. Devuelve un resumen corto con hechos, rutas o URLs y lo que no pudiste comprobar. No inventes.',
  },
  planner: {
    tools: ['read', 'list'],
    prompt:
      'Rol PLANNER. Lee lo necesario y devuelve un plan numerado y minimo: pasos, archivos afectados, riesgos y como probarlo. No ejecutes nada.',
  },
  implementer: {
    tools: ['read', 'list'],
    prompt:
      'Rol IMPLEMENTER. No puedes escribir ni ejecutar. Devuelve el cambio propuesto como diff o bloques por archivo, listo para que quien te delego lo aplique, y di que prueba lo cubriria.',
  },
});

export function isSubagentRole(value: unknown): value is SubagentRole {
  return typeof value === 'string' && (SUBAGENT_ROLES as readonly string[]).includes(value);
}

export interface ResolvedChildTools {
  allowed: string[];
  dropped: string[];
}

/**
 * Herramientas efectivas del hijo. Sin `requested` se usan las del rol. Todo lo
 * que no este a la vez en el rol y en SUBAGENT_SAFE_TOOLS se descarta.
 */
export function resolveChildToolNames(
  role: SubagentRole,
  requested?: readonly string[],
): ResolvedChildTools {
  const roleTools = SUBAGENT_ROLE_SPECS[role].tools;
  // undefined = las del rol; lista vacia explicita = ninguna herramienta.
  const wanted = requested === undefined ? roleTools : requested;
  const allowed: string[] = [];
  const dropped: string[] = [];
  for (const name of wanted) {
    const ok = roleTools.includes(name) && SUBAGENT_SAFE_TOOLS.includes(name);
    if (ok && !allowed.includes(name)) allowed.push(name);
    else if (!ok && !dropped.includes(name)) dropped.push(name);
  }
  return { allowed, dropped };
}

/** Filtra y envuelve las herramientas del padre: el hijo solo ve las permitidas. */
export function isolateTools(
  tools: readonly AgentTool[],
  allowed: readonly string[],
  signal?: AbortSignal,
  maxCalls?: number,
): AgentTool[] {
  let used = 0;
  const safe = new Set(allowed.filter((n) => SUBAGENT_SAFE_TOOLS.includes(n)));
  return tools
    .filter((tool) => safe.has(tool.name))
    .map((tool) => ({
      ...tool,
      execute: async (...args: Parameters<AgentTool['execute']>) => {
        if (!safe.has(tool.name))
          throw new Error(`Herramienta no permitida al subagente: ${tool.name}`);
        if (signal?.aborted) throw new Error('Subagente abortado: no se ejecuta la herramienta.');
        if (maxCalls !== undefined && used >= maxCalls)
          throw new Error('Presupuesto de herramientas del subagente agotado.');
        used++;
        return tool.execute(...args);
      },
    })) as AgentTool[];
}

/** Lo que el ejecutor pide a la fabrica de hijos. No lleva historial del padre. */
export interface ChildSpec {
  prompt: string;
  role: SubagentRole;
  tools: string[];
  /**
   * Herramientas YA aisladas por construccion (isolateTools sobre las del padre):
   * solo las permitidas, con tope de llamadas y corte al abortar. La fabrica
   * debe usar exactamente estas y ninguna otra.
   */
  toolset: AgentTool[];
  maxToolCalls: number;
  signal: AbortSignal;
}

export interface ChildHandle {
  run(prompt: string): Promise<{ text: string; toolCalls?: number; error?: string | null }>;
  abort(): void;
}

export interface SubagentRunnerOptions {
  /** Crea un hijo NUEVO por llamada (historial vacio, toolset ya aislado). */
  makeChild(spec: ChildSpec): Promise<ChildHandle>;
  /** Herramientas del padre de las que se deriva el toolset del hijo (se filtran aqui). */
  parentTools: () => readonly AgentTool[];
}

function readBudget(budget: unknown): SubagentBudget | undefined {
  const b = budget as Partial<SubagentBudget> | null | undefined;
  if (!b || typeof b.maxToolCalls !== 'number' || !b.signal) return undefined;
  return { maxToolCalls: b.maxToolCalls, tools: b.tools ?? [], signal: b.signal };
}

export function buildChildPrompt(role: SubagentRole, task: string): string {
  return [
    SUBAGENT_ROLE_SPECS[role].prompt,
    'No tienes historial previo ni permisos heredados. Responde con texto.',
    '',
    `Tarea: ${task}`,
  ].join('\n');
}

/** `SubagentDeps` real: valida rol y herramientas, crea hijo nuevo y propaga el aborto. */
export function createSubagentDeps(options: SubagentRunnerOptions): SubagentDeps {
  return {
    async run(request: SubagentRunRequest) {
      const role = request.role ?? 'explorer';
      if (!isSubagentRole(role)) {
        return { text: '', error: `Rol de subagente desconocido: ${String(role)}.` };
      }
      const budget = readBudget(request.budget);
      if (!budget) {
        return {
          text: '',
          error: 'Falta el presupuesto del subagente; no se ejecuta sin limites.',
        };
      }
      // Pedido del caller: request.tools (undefined = las del rol, [] = ninguna).
      const { allowed } = resolveChildToolNames(role, request.tools);
      if (budget.signal.aborted) return { text: '', error: 'Subagente abortado antes de empezar.' };
      const prompt = buildChildPrompt(role, request.task);
      const toolset = isolateTools(
        options.parentTools(),
        allowed,
        budget.signal,
        budget.maxToolCalls,
      );
      const child = await options.makeChild({
        prompt,
        role,
        tools: allowed,
        toolset,
        maxToolCalls: budget.maxToolCalls,
        signal: budget.signal,
      });
      // La fabrica pudo tardar mas que el timeout: si ya se aborto, no se ejecuta.
      if (budget.signal.aborted) {
        child.abort();
        return { text: '', error: 'Subagente abortado antes de empezar.' };
      }
      const onAbort = () => child.abort();
      budget.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const out = await child.run(prompt);
        return { text: out.text, toolCalls: out.toolCalls, error: out.error ?? null };
      } finally {
        budget.signal.removeEventListener('abort', onAbort);
      }
    },
  };
}
