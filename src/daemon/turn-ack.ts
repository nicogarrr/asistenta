/**
 * Acuse de un turno que va a tardar, como lo haría una persona en el chat.
 *
 * El indicador «escribiendo…» dice que alguien está, pero no qué hace. Cuando un
 * pedido tarda (más de unos segundos o varias herramientas seguidas) sale UNA línea
 * corta que nombra la tarea («Miro tu correo, dame un momento»), con frases que
 * varían. Una respuesta rápida no lleva acuse: llega la respuesta y ya.
 *
 * La línea es la primera versión de la nota de progreso del turno (se edita después
 * y se borra al llegar la respuesta), así que nunca suma mensajes al chat.
 */

/** Tiempo sin respuesta a partir del cual se avisa aunque no haya herramientas. */
export const ACK_AFTER_MS = 8_000;
/** Herramientas seguidas que ya son «varios pasos». */
export const ACK_AFTER_TOOLS = 2;

/** Frases por tipo de tarea; el nombre de la herramienta decide el tipo. */
const TASK_LINES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [
    /correo|mail/,
    [
      'Miro tu correo, dame un momento.',
      'Voy a tu correo, ahora te digo.',
      'Le echo un ojo a tu correo, un segundo.',
    ],
  ],
  [
    /^(?:agenda|calendar|tareas|reminder|objetivo)$/,
    [
      'Miro tu agenda, dame un momento.',
      'Lo miro en tu agenda, ahora te digo.',
      'Reviso tu agenda, un segundo.',
    ],
  ],
  [
    /^(?:browser|fetch|web|download)$/,
    [
      'Lo busco en internet, dame un momento.',
      'Miro en la web, ahora te digo.',
      'Lo estoy buscando, un segundo.',
    ],
  ],
  [
    /^(?:computer|windows|ocr|ocr_local|system|shell)$/,
    [
      'Me pongo con el ordenador, dame un momento.',
      'Voy al PC, ahora te digo.',
      'Lo hago en el ordenador, un segundo.',
    ],
  ],
  [/^tv$/, ['Voy con la tele, un momento.', 'Ahora con la tele, un segundo.']],
  [
    /^(?:documents|read|list|book|media)$/,
    ['Miro tus documentos, dame un momento.', 'Lo busco en tus archivos, ahora te digo.'],
  ],
  [/^renfe$/, ['Miro los trenes, dame un momento.', 'Busco trenes, ahora te digo.']],
  [/^repartos$/, ['Miro tus envíos, dame un momento.', 'Reviso tus paquetes, ahora te digo.']],
  [/^tiempo$/, ['Miro el tiempo, un segundo.', 'Consulto el tiempo, ahora te digo.']],
  [
    /^(?:checkout|vigilar_precio)$/,
    ['Miro precios, dame un momento.', 'Comparo precios, ahora te digo.'],
  ],
  [/^iphone$/, ['Voy con el iPhone, un momento.', 'Lo miro en el iPhone, ahora te digo.']],
];

const GENERIC = [
  'Me pongo con ello, dame un momento.',
  'Lo miro, ahora te digo.',
  'Dame un momento, voy con ello.',
];
const THINKING = [
  'Dame un momento, lo estoy pensando.',
  'Déjame pensarlo un segundo.',
  'Un momento, que lo pienso bien.',
];

/** El grupo de frases de la tarea más reciente que tenga nombre propio. */
function linesFor(tools: readonly string[]): readonly string[] {
  if (tools.length === 0) return THINKING;
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i] ?? '';
    for (const [pattern, lines] of TASK_LINES) if (pattern.test(tool)) return lines;
  }
  return GENERIC;
}

/** ¿Toca ya el acuse? Una vez por turno, y solo si el turno está tardando de verdad. */
export function ackDue(s: { elapsedMs: number; toolCalls: number; acked: boolean }): boolean {
  if (s.acked) return false;
  return s.elapsedMs >= ACK_AFTER_MS || s.toolCalls >= ACK_AFTER_TOOLS;
}

let lastLine = '';

/**
 * La línea de acuse para las herramientas usadas hasta ahora. No repite la del turno
 * anterior: la misma frase dos veces seguidas suena a contestador.
 */
export function ackLine(
  tools: readonly string[],
  pick: (n: number) => number = (n) => Math.floor(Math.random() * n),
): string {
  const lines = linesFor(tools);
  let index = Math.abs(pick(lines.length)) % lines.length;
  if (lines[index] === lastLine && lines.length > 1) index = (index + 1) % lines.length;
  lastLine = lines[index] ?? lines[0] ?? '';
  return lastLine;
}

/**
 * El acuse de un turno: se le avisa en cada tic y en cada herramienta, y publica la
 * línea una sola vez cuando toca. `enabled` lo apaga cuando el turno ya terminó, el
 * dueño quitó las notas (/estado off) o ya hubo otro acuse (nota de voz, foto).
 */
export class TurnAck {
  #acked = false;
  readonly #show: (text: string) => Promise<void> | void;
  readonly #enabled: () => boolean;

  constructor(deps: { show: (text: string) => Promise<void> | void; enabled: () => boolean }) {
    this.#show = deps.show;
    this.#enabled = deps.enabled;
  }

  get acked(): boolean {
    return this.#acked;
  }

  /** Publica el acuse si toca. Devuelve true solo la vez que lo publica. */
  tick(elapsedMs: number, tools: readonly string[]): boolean {
    if (!ackDue({ elapsedMs, toolCalls: tools.length, acked: this.#acked })) return false;
    if (!this.#enabled()) return false;
    this.#acked = true;
    void Promise.resolve(this.#show(ackLine(tools))).catch(() => {});
    return true;
  }
}
