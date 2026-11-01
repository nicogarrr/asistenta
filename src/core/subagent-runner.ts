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
import {
  buildSpecialistPrompt,
  resolveSpecialist,
  SPECIALIST_READ_TOOLS,
  type SpecialistSpec,
  specialistAllowsCall,
  specialistToolNames,
} from './specialists.js';
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

/**
 * Como `isolateTools`, pero para un especialista: solo su lista blanca y, en las
 * herramientas acotadas por acciones, solo esas acciones. No amplia nada: si el
 * especialista no tiene efectos, sus herramientas fuera de SUBAGENT_SAFE_TOOLS
 * solo pasan con acciones de lectura listadas en `actions`.
 */
export function isolateSpecialistTools(
  tools: readonly AgentTool[],
  specialist: SpecialistSpec,
  allowed: readonly string[],
  signal?: AbortSignal,
  maxCalls?: number,
): AgentTool[] {
  let used = 0;
  // Sin efectos = solo lectura: una herramienta fuera de las de lectura comprobada
  // solo entra si sus acciones estan acotadas en `actions`.
  const readable = (n: string) =>
    specialist.effectful ||
    SUBAGENT_SAFE_TOOLS.includes(n) ||
    SPECIALIST_READ_TOOLS.includes(n) ||
    specialist.actions?.[n] !== undefined;
  const names = new Set(allowed.filter((n) => specialist.tools.includes(n) && readable(n)));
  return tools
    .filter((tool) => names.has(tool.name))
    .map((tool) => ({
      ...tool,
      execute: async (...args: Parameters<AgentTool['execute']>) => {
        if (!names.has(tool.name) || !specialistAllowsCall(specialist, tool.name, args[1]))
          throw new Error(
            `El especialista ${specialist.title} no puede usar ${tool.name} con esa acción.`,
          );
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
  /** Especialista resuelto, si el padre pidio uno conocido (su Gate depende de el). */
  specialist?: SpecialistSpec;
  /** Solo especialistas con efectos: pregunta al humano por cada accion. */
  approve?: SpecialistApprove;
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

/**
 * Herramientas del HILO que delega (si el cableado por hilo las pasa en
 * `context.parentTools`); si no, las del proceso. Asi el especialista de correo
 * ve el `correo` de ESTE chat, con sus propias comprobaciones (solo el privado
 * del dueno), y nunca el de otro.
 */
function contextTools(context: unknown): (() => readonly AgentTool[]) | undefined {
  const c = context as { parentTools?: unknown } | null | undefined;
  return c && typeof c.parentTools === 'function'
    ? (c.parentTools as () => readonly AgentTool[])
    : undefined;
}

/**
 * Canal para preguntar al humano (lo pone el cableado por hilo). Sin el, un
 * especialista con efectos no se ejecuta: no habria a quien pedir permiso.
 */
export type SpecialistApprove = (question: string) => Promise<boolean>;

function contextApprove(context: unknown): SpecialistApprove | undefined {
  const c = context as { approve?: unknown } | null | undefined;
  return c && typeof c.approve === 'function' ? (c.approve as SpecialistApprove) : undefined;
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
      const specialist =
        request.specialist === undefined ? undefined : resolveSpecialist(request.specialist);
      const role = request.role ?? 'explorer';
      if (!specialist && !isSubagentRole(role)) {
        return { text: '', error: `Rol de subagente desconocido: ${String(role)}.` };
      }
      const approve = contextApprove(request.context);
      if (specialist?.effectful && !approve) {
        return {
          text: '',
          error: `El especialista ${specialist.title} ${specialist.changes ?? 'actúa sobre aparatos o cuentas'} y aquí no tiene forma de pedirte permiso; no se ejecuta.`,
        };
      }
      const budget = readBudget(request.budget);
      if (!budget) {
        return {
          text: '',
          error: 'Falta el presupuesto del subagente; no se ejecuta sin limites.',
        };
      }
      if (budget.signal.aborted) return { text: '', error: 'Subagente abortado antes de empezar.' };
      const parentTools = contextTools(request.context) ?? options.parentTools;
      let child: ChildHandle;
      let prompt: string;
      if (specialist) {
        // Un especialista solo recibe SU lista; `tools` del caller solo la estrecha.
        const allowed = specialistToolNames(specialist, request.tools);
        prompt = buildSpecialistPrompt(specialist, request.task);
        const toolset = isolateSpecialistTools(
          parentTools(),
          specialist,
          allowed,
          budget.signal,
          budget.maxToolCalls,
        );
        child = await options.makeChild({
          prompt,
          role: 'explorer',
          tools: allowed,
          toolset,
          maxToolCalls: budget.maxToolCalls,
          signal: budget.signal,
          specialist,
          ...(specialist.effectful && approve ? { approve } : {}),
        });
      } else {
        const genericRole = role as SubagentRole;
        // Pedido del caller: request.tools (undefined = las del rol, [] = ninguna).
        const { allowed } = resolveChildToolNames(genericRole, request.tools);
        prompt = buildChildPrompt(genericRole, request.task);
        const toolset = isolateTools(parentTools(), allowed, budget.signal, budget.maxToolCalls);
        child = await options.makeChild({
          prompt,
          role: genericRole,
          tools: allowed,
          toolset,
          maxToolCalls: budget.maxToolCalls,
          signal: budget.signal,
        });
      }
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
