/**
 * Pool de subagentes.
 *
 * El pool no sabe nada del modelo ni de la red: recibe un `SubagentDeps` ya
 * cableado y se limita a decidir profundidad, concurrencia, presupuesto y
 * timeout. Asi se puede probar entero con un doble en memoria.
 *
 * Contrato del hijo, deliberadamente estricto:
 * - Su historial es NUEVO. El pool solo pasa `task`, `depth` y `budget`; nunca
 *   el transcript del padre. Un hijo no debe "recordar" mensajes, decisiones ni
 *   aprobaciones que no se le pasaron de forma explicita.
 * - No hereda herramientas con efectos. `SubagentRequest.tools` es una lista
 *   blanca de nombres y el caller debe construir el toolset del hijo con
 *   herramientas sin efectos secundarios (lectura, busqueda, calculo). El pool
 *   no puede comprobarlo, por eso el contrato queda escrito aqui.
 * - No hereda aprobaciones previas. Cualquier accion sensible del hijo debe
 *   volver a pedir permiso por su cuenta.
 * - El hijo devuelve texto, no mensajes estructurados ni llamadas a tools del
 *   padre.
 *
 * `budget` es opaco para el tipo, pero la implementacion por defecto entrega un
 * objeto con el techo de llamadas, la lista blanca de tools y la senal de
 * aborto. Un `SubagentDeps` puede ignorarlo o usarlo para cortar antes.
 *
 * El timeout usa `Promise.race` contra una senal interna. Al vencer se aborta
 * la senal y se devuelve un error; el resultado tardio del hijo se descarta, de
 * modo que nunca escribe en el hilo del padre.
 */

/** Limites duros del pool. */
export interface SubagentLimits {
  /** Niveles de anidamiento permitidos contando desde el hijo directo. */
  maxDepth: number;
  /** Subagentes que pueden ejecutarse a la vez. */
  maxConcurrent: number;
  /** Techo de llamadas a herramientas que se anuncia al hijo. */
  maxToolCalls: number;
}

/** Valores por defecto: dos niveles, dos en paralelo y 25 llamadas por hijo. */
export const SUBAGENT_DEFAULT_LIMITS: Readonly<SubagentLimits> = Object.freeze({
  maxDepth: 2,
  maxConcurrent: 2,
  maxToolCalls: 25,
});

/** Cinco minutos: una tarea delegada no puede colgar el turno del padre. */
export const SUBAGENT_DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** Lo que pide el padre al pool. */
export interface SubagentRequest {
  task: string;
  /** Rol opcional (explorer, planner, implementer); lo interpreta el ejecutor. */
  role?: string;
  /** Profundidad del agente que delega; el hijo empieza en `parentDepth + 1`. */
  parentDepth?: number;
  /** Lista blanca de nombres de herramientas sin efectos. */
  tools?: string[];
  /** Especialista con nombre (core/specialists.ts); desconocido = hijo generico. */
  specialist?: string;
  /**
   * Contexto del hilo que delega, opaco para el pool (p. ej. sus herramientas).
   * Se pasa tal cual al ejecutor; nunca lleva el transcript del padre.
   */
  context?: unknown;
}

/** Lo que recibe el ejecutor inyectado. No incluye el transcript del padre. */
export interface SubagentRunRequest {
  task: string;
  role?: string;
  /** undefined = el caller no pidio lista (usa las del rol); [] = ninguna herramienta. */
  tools?: readonly string[];
  /** Especialista pedido por el padre; lo resuelve el ejecutor. */
  specialist?: string;
  /** Contexto del hilo (ver SubagentRequest.context). */
  context?: unknown;
  depth: number;
  budget: unknown;
}

/** Lo que devuelve el ejecutor inyectado. */
export interface SubagentRunResult {
  text: string;
  toolCalls?: number;
  error?: string | null;
}

/** Dependencias inyectables: en tests basta una funcion en memoria. */
export interface SubagentDeps {
  run(request: SubagentRunRequest): Promise<SubagentRunResult>;
}

/** Resultado uniforme del pool. Los errores nunca se lanzan. */
export interface SubagentResult {
  text: string;
  depth: number;
  error?: string;
}

/**
 * Forma recomendada del `budget` (el tipo publico es `unknown` para no atar a
 * los llamadores). `signal` se aborta al vencer el timeout o al terminar.
 */
export interface SubagentBudget {
  maxToolCalls: number;
  tools: readonly string[];
  signal: AbortSignal;
}

/** El segundo argumento tambien admite `timeoutMs` para no esperar 5 minutos en tests. */
export interface SubagentPoolOptions extends Partial<SubagentLimits> {
  timeoutMs?: number;
}

function readLimit(value: number | undefined, fallback: number, min: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min) {
    throw new RangeError(
      `${name} debe ser un entero mayor o igual que ${min}, recibido ${resolved}`,
    );
  }
  return resolved;
}

function readTimeout(value: number | undefined): number {
  const resolved = value ?? SUBAGENT_DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new RangeError(`timeoutMs debe ser un entero no negativo, recibido ${resolved}`);
  }
  return resolved;
}

function normalizeParentDepth(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.trim() || error.name;
  return String(error);
}

function timeoutMessage(ms: number): string {
  return `Tiempo agotado (timeout) tras ${ms} ms esperando al subagente.`;
}

export class SubagentPool {
  readonly #deps: SubagentDeps;
  readonly #limits: Readonly<SubagentLimits>;
  /** Cola FIFO de resoluciones de `#acquire`; nunca guarda tareas ya iniciadas. */
  readonly #queue: Array<() => void> = [];
  #active = 0;
  #timeoutMs: number;

  constructor(
    deps: SubagentDeps,
    options: SubagentPoolOptions = {},
    overrides: { timeoutMs?: number } = {},
  ) {
    this.#deps = deps;
    this.#limits = Object.freeze({
      maxDepth: readLimit(options.maxDepth, SUBAGENT_DEFAULT_LIMITS.maxDepth, 0, 'maxDepth'),
      maxConcurrent: readLimit(
        options.maxConcurrent,
        SUBAGENT_DEFAULT_LIMITS.maxConcurrent,
        1,
        'maxConcurrent',
      ),
      maxToolCalls: readLimit(
        options.maxToolCalls,
        SUBAGENT_DEFAULT_LIMITS.maxToolCalls,
        0,
        'maxToolCalls',
      ),
    });
    this.#timeoutMs = readTimeout(overrides.timeoutMs ?? options.timeoutMs);
  }

  /** Limites efectivos, ya resueltos con los valores por defecto. */
  get limits(): Readonly<SubagentLimits> {
    return this.#limits;
  }

  /** Timeout en milisegundos; se puede ajustar despues de construir el pool. */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  set timeoutMs(ms: number) {
    this.#timeoutMs = readTimeout(ms);
  }

  async run(request: SubagentRequest): Promise<SubagentResult> {
    const depth = normalizeParentDepth(request.parentDepth) + 1;
    if (depth > this.#limits.maxDepth) {
      return {
        text: '',
        depth,
        error: `Profundidad ${depth} supera el maximo permitido (${this.#limits.maxDepth}).`,
      };
    }
    if (!request.task.trim()) {
      return { text: '', depth, error: 'La tarea del subagente esta vacia.' };
    }

    // Copia antes de esperar turno: el caller no puede cambiar la tarea ni la
    // lista de tools mientras la peticion esta en la cola.
    const task = request.task;
    const role = request.role;
    const specialist = typeof request.specialist === 'string' ? request.specialist : undefined;
    const context = request.context;
    const tools =
      request.tools === undefined
        ? undefined
        : request.tools.filter((name) => typeof name === 'string' && name.trim().length > 0);

    await this.#acquire();
    try {
      return await this.#execute(task, depth, tools, role, specialist, context);
    } finally {
      this.#release();
    }
  }

  /** Toma un turno o espera en FIFO. La cola no salta nunca a un recien llegado. */
  #acquire(): Promise<void> {
    if (this.#active < this.#limits.maxConcurrent) {
      this.#active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#queue.push(resolve);
    });
  }

  /** Libera el turno y arranca tantas tareas encoladas como quepan, en orden. */
  #release(): void {
    this.#active--;
    while (this.#active < this.#limits.maxConcurrent) {
      const next = this.#queue.shift();
      if (!next) break;
      this.#active++;
      next();
    }
  }

  async #execute(
    task: string,
    depth: number,
    toolNames: string[] | undefined,
    role?: string,
    specialist?: string,
    context?: unknown,
  ): Promise<SubagentResult> {
    const controller = new AbortController();
    const budget: SubagentBudget = Object.freeze({
      maxToolCalls: this.#limits.maxToolCalls,
      tools: Object.freeze([...(toolNames ?? [])]),
      signal: controller.signal,
    });
    const expired = new Error(timeoutMessage(this.#timeoutMs));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(expired);
        reject(expired);
      }, this.#timeoutMs);
    });

    try {
      const result = await Promise.race([
        this.#deps.run({
          task,
          depth,
          budget,
          ...(role ? { role } : {}),
          ...(specialist ? { specialist } : {}),
          ...(context !== undefined ? { context } : {}),
          ...(toolNames ? { tools: Object.freeze([...toolNames]) } : {}),
        }),
        timeout,
      ]);
      const childError =
        result.error === undefined || result.error === null ? '' : String(result.error).trim();
      if (childError) return { text: '', depth, error: childError };

      if (
        typeof result.toolCalls === 'number' &&
        Number.isFinite(result.toolCalls) &&
        result.toolCalls > this.#limits.maxToolCalls
      ) {
        return {
          text: '',
          depth,
          error:
            `El subagente hizo ${result.toolCalls} llamadas a herramientas ` +
            `y supero el limite de ${this.#limits.maxToolCalls}.`,
        };
      }

      return { text: result.text, depth };
    } catch (error) {
      return {
        text: '',
        depth,
        // Si la senal ya esta abortada, el fallo es del timeout aunque el hijo
        // haya rechazado con su propio AbortError al escuchar la senal.
        error: controller.signal.aborted ? expired.message : errorMessage(error),
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Abortar tambien al terminar bien: si el hijo dejo trabajo en segundo
      // plano, no debe seguir consumiendo despues de devolver el control.
      controller.abort();
    }
  }
}
