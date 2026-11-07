/**
 * Cómo se repite una ruta aprendida (core/rutas.ts) sin preguntar al modelo en cada paso.
 *
 * El bucle del agente es el mismo de siempre: cada paso es una llamada a la herramienta
 * `browser` que pasa por el control de permisos, el registro, el detector de bucles y el
 * presupuesto, igual que si la hubiera pedido el modelo. Lo único distinto es quién
 * «decide» el siguiente paso: mientras la ruta va bien, lo saca de la receta en vez de
 * llamar al proveedor. Cuando un paso no sale como la otra vez (error, aviso, la página
 * no cambió) o se acaban los pasos, el modelo de verdad vuelve a mandar.
 *
 * El modelo no ve llamadas que no hizo: antes de cada petición, los mensajes de la ruta
 * se juntan en una sola nota de texto («Ruta aprendida: 1. open … ✓ 2. fill … ✓ …»), con
 * el resultado del último paso. Así no hay llamadas ajenas en su historial (algunos
 * proveedores las rechazan) y gasta menos.
 */
import type { AssistantMessage, AssistantMessageEventStream, Model } from '@earendil-works/pi-ai';
import { stepWarning } from './hecho.js';
import { describeStep, type RouteMatch, type RouteStep } from './rutas.js';

/**
 * pi-ai se carga solo cuando de verdad se repite una ruta: las órdenes `pa …` que no
 * hablan con el modelo no lo pagan al arrancar (test/rend2-ia-perezosa.test.ts).
 */
let makeStream: (() => AssistantMessageEventStream) | null = null;

/** Prepara lo necesario para repetir pasos; se llama antes de empezar una ruta. */
export async function loadReplay(): Promise<void> {
  if (makeStream) return;
  const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
  makeStream = createAssistantMessageEventStream;
}

/** Las llamadas que hace la ruta llevan este prefijo en su id. */
export const ROUTE_CALL_PREFIX = 'ruta_';
/** Texto del último paso que ve el modelo (el resto de la ruta va en una línea por paso). */
const LAST_RESULT_CHARS = 4_000;
/** En turnos viejos, cada paso de la ruta ocupa poco. */
const OLD_RESULT_CHARS = 300;

export interface ReplayState {
  routeId: string;
  template: string;
  steps: RouteStep[];
  /** Siguiente paso a mandar. */
  next: number;
  status: 'running' | 'ok' | 'mismatch';
  /** Por qué se paró, en castellano llano. */
  reason?: string;
  /** Pasos que ya volvieron (bien o mal). */
  done: number;
  nonce: string;
}

export function startReplay(match: RouteMatch): ReplayState {
  return {
    routeId: match.route.id,
    template: match.route.template,
    steps: match.steps,
    next: 0,
    status: match.steps.length ? 'running' : 'ok',
    done: 0,
    nonce: Math.random().toString(36).slice(2, 8),
  };
}

export const isRouteCall = (id: string): boolean => id.startsWith(ROUTE_CALL_PREFIX);

/**
 * Lo que volvió de un paso de la ruta. Un error, un aviso de la herramienta o un clic que
 * no cambió la página paran la ruta: el modelo sigue desde ahí.
 */
export function noteRouteResult(
  state: ReplayState,
  callId: string,
  isError: boolean,
  text: string,
): void {
  if (!isRouteCall(callId) || state.status !== 'running') return;
  state.done += 1;
  const warn = isError ? 'dio error' : stepWarning(text);
  if (warn) {
    state.status = 'mismatch';
    state.reason = `el paso ${state.done} (${describeStep(state.steps[state.done - 1]?.args ?? {})}) no salió como la otra vez: ${warn}`;
    return;
  }
  if (state.done >= state.steps.length) state.status = 'ok';
}

/**
 * El siguiente paso de la ruta como si lo hubiera pedido el modelo, o null si ya no toca
 * (la ruta terminó o se paró): entonces pregunta el modelo de verdad.
 */
export function scriptedStep(
  state: ReplayState | null,
  model: Model<string>,
  signal?: AbortSignal,
  messages?: readonly { role?: unknown }[],
): AssistantMessageEventStream | null {
  if (!state || state.status !== 'running' || state.next >= state.steps.length) return null;
  if (!makeStream) return null; // sin loadReplay() no se repite nada: pregunta el modelo
  // Nico ha escrito algo a media ruta (una corrección, «para»): manda él, no la receta.
  if (state.next > 0 && messages?.at(-1)?.role === 'user') {
    state.status = 'mismatch';
    state.reason = 'Nico escribió a media ruta';
    return null;
  }
  // Un paso a la vez: el siguiente sale cuando ha vuelto el anterior.
  if (state.done < state.next) return null;
  const index = state.next;
  state.next += 1;
  const step = state.steps[index] as RouteStep;
  const toolCall = {
    type: 'toolCall' as const,
    id: `${ROUTE_CALL_PREFIX}${state.nonce}_${index + 1}`,
    name: 'browser',
    arguments: { ...step.args },
  };
  const message: AssistantMessage = {
    role: 'assistant',
    content: [toolCall],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    responseId: `${ROUTE_CALL_PREFIX}${state.nonce}`,
    timestamp: Date.now(),
  };
  const stream = makeStream();
  queueMicrotask(() => {
    if (signal?.aborted) {
      const aborted: AssistantMessage = { ...message, content: [], stopReason: 'aborted' };
      stream.push({ type: 'error', reason: 'aborted', error: aborted });
      stream.end(aborted);
      return;
    }
    const empty: AssistantMessage = { ...message, content: [] };
    stream.push({ type: 'start', partial: empty });
    stream.push({
      type: 'toolcall_start',
      contentIndex: 0,
      partial: { ...message, content: [{ ...toolCall, arguments: {} }] },
    });
    stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall, partial: message });
    stream.push({ type: 'done', reason: 'toolUse', message });
    stream.end(message);
  });
  return stream;
}

type Msg = { role?: unknown; content?: unknown; toolCallId?: unknown; isError?: unknown };
type ToolCallBlock = { type?: unknown; id?: unknown; arguments?: unknown };

function callsOf(message: Msg): ToolCallBlock[] {
  return Array.isArray(message.content)
    ? (message.content as ToolCallBlock[]).filter((c) => c?.type === 'toolCall')
    : [];
}

function textOf(message: Msg): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return (message.content as Array<{ type?: unknown; text?: unknown }>)
    .map((c) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .join('\n');
}

const isRouteAssistant = (m: Msg): boolean =>
  m.role === 'assistant' &&
  callsOf(m).length > 0 &&
  callsOf(m).every((c) => typeof c.id === 'string' && isRouteCall(c.id));

/**
 * Junta los mensajes de cada ruta repetida en una nota de texto, para el modelo. Lo que
 * no es de una ruta se queda igual. `running` = la ruta de este turno sigue: no se toca
 * nada (no hay petición al proveedor mientras tanto).
 */
export function collapseRouteMessages<T>(messages: T[], template?: string, running = false): T[] {
  if (running) return messages;
  const list = messages as unknown as Msg[];
  if (!list.some(isRouteAssistant)) return messages;
  // Bloques de la ruta: llamadas de la ruta y sus resultados, seguidos.
  const out: Msg[] = [];
  let i = 0;
  const lastBlockStart = list.map(isRouteAssistant).lastIndexOf(true);
  while (i < list.length) {
    const m = list[i] as Msg;
    if (!isRouteAssistant(m)) {
      out.push(m);
      i += 1;
      continue;
    }
    const lines: string[] = [];
    let lastText = '';
    let failed = '';
    let n = 0;
    let isLast = false;
    while (i < list.length) {
      const cur = list[i] as Msg;
      if (isRouteAssistant(cur)) {
        if (i >= lastBlockStart) isLast = true;
        const call = callsOf(cur)[0] as ToolCallBlock;
        const args = (call.arguments ?? {}) as Record<string, unknown>;
        const result = list[i + 1] as Msg | undefined;
        const hasResult = result?.role === 'toolResult' && result.toolCallId === call.id;
        const text = hasResult ? textOf(result) : '';
        const bad = hasResult
          ? result.isError === true
            ? 'dio error'
            : stepWarning(text)
          : 'sin resultado';
        n += 1;
        lines.push(`${n}. ${describeStep(args)} ${bad ? `✗ (${bad})` : '✓'}`);
        if (bad && !failed) failed = `paso ${n}: ${bad}`;
        lastText = text;
        i += hasResult ? 2 : 1;
        continue;
      }
      break;
    }
    const cap = isLast ? LAST_RESULT_CHARS : OLD_RESULT_CHARS;
    const head = `[Ruta aprendida${template ? ` «${template}»` : ''}: Asistenta repitió sola los pasos de la otra vez, sin preguntar al modelo.]`;
    const tail = failed
      ? `Se paró en el ${failed}. Los pasos anteriores YA están hechos: no los repitas. Mira la página (snapshot) y sigue desde ahí.`
      : 'Todos los pasos salieron bien. Mira la página (snapshot) para comprobar que está lo pedido y responde; di en una frase corta que lo has hecho con la ruta aprendida.';
    const note = [
      head,
      ...lines,
      lastText ? `Resultado del último paso:\n${lastText.slice(0, cap)}` : '',
      tail,
    ]
      .filter(Boolean)
      .join('\n');
    const prev = out[out.length - 1];
    if (prev && prev.role === 'user') {
      const content =
        typeof prev.content === 'string' ? [{ type: 'text', text: prev.content }] : prev.content;
      out[out.length - 1] = {
        ...prev,
        content: [...(Array.isArray(content) ? content : []), { type: 'text', text: note }],
      };
    } else {
      out.push({
        role: 'user',
        content: [{ type: 'text', text: note }],
        timestamp: Date.now(),
      } as Msg);
    }
  }
  return out as unknown as T[];
}
