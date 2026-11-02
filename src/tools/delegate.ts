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
import { type BackgroundJob, backgroundStartedText } from '../core/background-delegate.js';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { resolveSpecialist, SPECIALISTS, specialistNames } from '../core/specialists.js';
import type { SubagentPool } from '../core/subagent.js';

export const DELEGATE_TOOL_NAME = 'delegate';

const DelegateParams = lazySchema(() =>
  Type.Object({
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
    background: Type.Optional(
      Type.Boolean({
        description:
          'true para una lectura larga (varias fuentes, varios minutos): corre aparte, tú contestas ya y el resultado llega solo a esta conversación. No con specialist.',
      }),
    ),
  }),
);

export interface DelegateDetails {
  depth: number;
  /** Especialista que hizo la tarea (nombre canonico). */
  specialist?: string;
  /** Nombre pedido que no existe: lo hizo un subagente generico. */
  unknownSpecialist?: string;
  /** Pidió permiso para alguna acción y no se le dio ninguno: no hizo lo que pidió. */
  denied?: true;
  error?: string;
  /** Se lanzó en segundo plano: el resultado llega después como turno del hilo. */
  background?: true;
}

function specialistLine(): string {
  const parts = specialistNames().map((name) => {
    const spec = SPECIALISTS[name];
    return spec ? `${name} (${spec.examples.join('; ')})` : name;
  });
  return `Especialistas: ${parts.join(', ')}. Usa specialist cuando la tarea tenga varios pasos en un area (revisar varios correos, buscar hueco en el calendario, apuntar y programar varias notas o recordatorios, comparar en la web, varios pasos en el PC, la tele o la casa); para una sola accion sencilla usa tu la herramienta directamente.`;
}

/**
 * Aviso para el modelo cuando pide un especialista que no existe: lo hizo el
 * subagente genérico (solo herramientas de lectura) y estos son los nombres válidos.
 */
export function unknownSpecialistNotice(name: string): string {
  const shown = name
    .replace(/[\s«»]+/g, ' ')
    .trim()
    .slice(0, 40);
  return `Aviso: no existe el especialista «${shown}» (los que hay: ${specialistNames().join(', ')}). Esta tarea la hizo un subagente genérico, solo con herramientas de lectura; para la próxima usa uno de esos nombres.`;
}

/**
 * El hijo terminó sin decir nada (texto vacío y sin error). Un resultado vacío no es
 * un «hecho»: el modelo lo lee así y no puede contar que la tarea salió bien.
 */
export function emptyResultNotice(specialistTitle?: string): string {
  const who = specialistTitle ? `El especialista ${specialistTitle}` : 'El subagente';
  return `${who} terminó sin devolver ninguna respuesta, así que no sabes qué hizo. No lo des por hecho: compruébalo tú o díselo al usuario.`;
}

/**
 * El especialista pidió permiso para una o más acciones y no se le dio ninguno
 * (denegadas, retiradas o caducadas): no hizo nada de lo que pidió.
 */
export function deniedActionsNotice(specialistTitle: string): string {
  return `Aviso: el especialista ${specialistTitle} no tuvo permiso para ninguna de las acciones que pidió (denegadas o caducadas), así que no hizo ninguna. No lo des por hecho.`;
}

/**
 * Falló (error, tiempo agotado, /stop) después de que se aprobaran acciones del
 * especialista: esas acciones pudieron hacerse aunque la tarea acabe en error.
 */
export function approvedBeforeErrorNotice(specialistTitle: string, granted: number): string {
  const what = granted === 1 ? 'se aprobó 1 acción' : `se aprobaron ${granted} acciones`;
  return `Ojo: antes del fallo ${what} del especialista ${specialistTitle}, que pudo hacerse igualmente. No digas que no se hizo nada: compruébalo o díselo así al usuario.`;
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
    approve?: (question: string, signal?: AbortSignal) => Promise<boolean>;
    /**
     * Arranca una subtarea en segundo plano (`background: true`); false si ahora no
     * se puede (tope del hilo, turno del panel) y entonces se hace esperando.
     */
    background?: (job: BackgroundJob) => boolean;
  },
): AgentTool<ReturnType<typeof DelegateParams>, DelegateDetails> {
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
    parameters: DelegateParams(),
    executionMode: 'parallel',
    execute: async (_toolCallId, args, signal) => {
      const specialist =
        args.specialist === undefined ? undefined : resolveSpecialist(args.specialist);
      // En segundo plano solo el subagente genérico (lectura): un especialista con
      // efectos pregunta al humano y eso no puede quedarse colgado fuera del turno.
      if (args.background === true && args.specialist === undefined && thread?.background) {
        const parentTools = thread.parentTools;
        const started = thread.background({
          task: args.task,
          run: async (jobSignal) => {
            const result = await pool.run({
              task: args.task,
              parentDepth: depthOf(),
              ...(args.role ? { role: args.role } : {}),
              ...(args.tools ? { tools: args.tools } : {}),
              signal: jobSignal,
              // Sin approve: el hijo no hereda aprobaciones ni puede pedirlas.
              context: { parentTools },
            });
            if (result.error !== undefined) throw new Error(result.error);
            if (result.text.trim() === '') throw new Error(emptyResultNotice(undefined));
            return result.text;
          },
        });
        if (started) {
          return {
            content: [{ type: 'text', text: backgroundStartedText(args.task) }],
            details: { depth: depthOf() + 1, background: true },
          };
        }
      }
      // Cuántas preguntas hizo esta delegación y a cuántas se dijo que sí (solo cuenta:
      // la respuesta del humano pasa tal cual).
      let asked = 0;
      let granted = 0;
      const ask = thread?.approve;
      const approve = ask
        ? async (question: string, signal?: AbortSignal) => {
            asked++;
            const ok = await ask(question, signal);
            if (ok === true) granted++;
            return ok;
          }
        : undefined;
      const result = await pool.run({
        task: args.task,
        parentDepth: depthOf(),
        ...(specialist ? { specialist: specialist.name } : {}),
        ...(args.role ? { role: args.role } : {}),
        ...(args.tools ? { tools: args.tools } : {}),
        // El /stop del hilo llega aquí: el hijo se corta y no ejecuta nada más.
        ...(signal ? { signal } : {}),
        ...(thread
          ? {
              context: {
                parentTools: thread.parentTools,
                ...(approve ? { approve } : {}),
              },
            }
          : {}),
      });

      // El modelo debe ver el fallo como texto util, no un contenido vacio; el
      // detalle estructurado queda para quien consuma el resultado.
      // Sin error pero sin texto: se dice como fallo (y sin línea «🧩 Lo hizo…»).
      const empty = result.error === undefined && result.text.trim() === '';
      const error = empty ? emptyResultNotice(specialist?.title) : result.error;
      // Pidió permiso y no se le dio ninguno: no es un «Lo hizo» (ni para el modelo).
      const denied = error === undefined && specialist !== undefined && asked > 0 && granted === 0;
      const body = error
        ? specialist && granted > 0
          ? `${error}\n\n${approvedBeforeErrorNotice(specialist.title, granted)}`
          : error
        : denied && specialist
          ? `${result.text}\n\n${deniedActionsNotice(specialist.title)}`
          : result.text;
      // Un nombre que no existe no debe pasar desapercibido: el modelo lo lee aquí
      // (y no solo en details) para no volver a pedirlo ni creer que lo hizo el bueno.
      const text =
        !specialist && args.specialist !== undefined
          ? `${unknownSpecialistNotice(args.specialist)}\n\n${body}`
          : body;
      const details: DelegateDetails = { depth: result.depth };
      if (specialist) details.specialist = specialist.name;
      else if (args.specialist !== undefined) details.unknownSpecialist = args.specialist;
      if (denied) details.denied = true;
      if (error) details.error = error;

      return {
        content: [{ type: 'text', text }],
        details,
      };
    },
  };
}
