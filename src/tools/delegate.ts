/**
 * Herramienta de delegacion.
 *
 * Un subagente sirve para trabajo acotado que ensuciaria el hilo principal:
 * buscar y comparar fuentes, leer varios documentos o explorar un problema en
 * paralelo. No sirve para esquivar permisos ni para "recordar" el contexto: el
 * hijo empieza con historial nuevo y sin aprobaciones heredadas.
 *
 * El caller sigue siendo responsable del aislamiento. Debe pasar un toolset
 * construido solo con herramientas sin efectos secundarios; `tools` aqui es la
 * lista blanca de nombres que el ejecutor del hijo debe respetar.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { resolveSpecialist, SPECIALISTS, specialistNames } from '../core/specialists.js';
import type { SubagentPool } from '../core/subagent.js';

export const DELEGATE_TOOL_NAME = 'delegate';

const DelegateParams = Type.Object({
  task: Type.String({
    minLength: 1,
    maxLength: 4000,
    description: 'Tarea concreta y autocontenida para el subagente, con el resultado esperado.',
  }),
  role: Type.Optional(
    Type.Union([Type.Literal('explorer'), Type.Literal('planner'), Type.Literal('implementer')], {
      description:
        'explorer: lee y resume. planner: plan por pasos. implementer: propone el cambio como texto/diff; no escribe.',
    }),
  ),
  specialist: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 40,
      description: `Especialista que hace la tarea con sus propias instrucciones y herramientas: ${specialistNames().join(', ')}. Si no existe, se usa un subagente genérico.`,
    }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      maxItems: 32,
      description:
        'Nombres de herramientas que el hijo puede usar. Deben ser herramientas sin efectos secundarios.',
    }),
  ),
});

export interface DelegateDetails {
  depth: number;
  /** Especialista que hizo la tarea (nombre canonico). */
  specialist?: string;
  /** Nombre pedido que no existe: lo hizo un subagente generico. */
  unknownSpecialist?: string;
  error?: string;
}

function specialistLine(): string {
  const parts = specialistNames().map((name) => {
    const spec = SPECIALISTS[name];
    return spec ? `${name} (${spec.examples.join('; ')})` : name;
  });
  return `Especialistas: ${parts.join(', ')}. Usa specialist cuando la tarea tenga varios pasos en un area (revisar varios correos, buscar hueco en el calendario, comparar en la web, varios pasos en el PC, la tele o la casa); para una sola accion sencilla usa tu la herramienta directamente.`;
}

/**
 * Crea la tool `delegate` sobre un pool ya configurado. `depthOf` devuelve la
 * profundidad del agente actual (el padre); el pool calcula la del hijo.
 */
export function createDelegateTool(
  pool: SubagentPool,
  depthOf: () => number,
  /** Herramientas del hilo que delega; sin ellas, las del proceso (ver subagent-runner). */
  thread?: {
    parentTools: () => readonly AgentTool[];
    /** Pregunta al humano del hilo; solo la usan los especialistas con efectos. */
    approve?: (question: string) => Promise<boolean>;
  },
): AgentTool<typeof DelegateParams, DelegateDetails> {
  return {
    name: DELEGATE_TOOL_NAME,
    label: 'Delegar',
    description: [
      'Delega una tarea acotada a un subagente con historial y contexto nuevos.',
      'Usalo para trabajo paralelizable o de lectura larga (buscar, resumir, comparar fuentes) que ensuciaria este hilo.',
      'No lo uses para pagos, compras, mensajes a terceros, borrados, escrituras ni decisiones irreversibles: el hijo no hereda aprobaciones previas y esas acciones seguirian necesitando permiso.',
      'Pasa en tools solo herramientas sin efectos secundarios; el hijo no recibe el transcript del padre ni sus permisos, y devuelve un resumen en texto.',
      specialistLine(),
    ].join(' '),
    parameters: DelegateParams,
    executionMode: 'parallel',
    execute: async (_toolCallId, args) => {
      const specialist =
        args.specialist === undefined ? undefined : resolveSpecialist(args.specialist);
      const result = await pool.run({
        task: args.task,
        parentDepth: depthOf(),
        ...(specialist ? { specialist: specialist.name } : {}),
        ...(args.role ? { role: args.role } : {}),
        ...(args.tools ? { tools: args.tools } : {}),
        ...(thread
          ? {
              context: {
                parentTools: thread.parentTools,
                ...(thread.approve ? { approve: thread.approve } : {}),
              },
            }
          : {}),
      });

      // El modelo debe ver el fallo como texto util, no un contenido vacio; el
      // detalle estructurado queda para quien consuma el resultado.
      const text = result.error ?? result.text;
      const details: DelegateDetails = { depth: result.depth };
      if (specialist) details.specialist = specialist.name;
      else if (args.specialist !== undefined) details.unknownSpecialist = args.specialist;
      if (result.error) details.error = result.error;

      return {
        content: [{ type: 'text', text }],
        details,
      };
    },
  };
}
