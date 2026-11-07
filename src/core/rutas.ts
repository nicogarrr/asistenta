/**
 * Rutas aprendidas (idea de POKI, reescrita en nuestro código; POKI es AGPL y no se ha
 * copiado nada).
 *
 * Cuando una tarea de navegador sale bien (por ejemplo, buscar un producto en Mercadona
 * y mirar su precio), sus pasos se guardan como una receta con huecos: lo que Nico
 * escribió y luego se tecleó en la página («leche») pasa a ser un hueco. La próxima vez
 * que llega la misma petición con otro valor («mira el precio de huevos en Mercadona»),
 * Asistenta repite los pasos ella sola, sin preguntar al modelo en cada paso, y comprueba
 * cada uno. En cuanto un paso no sale como la otra vez, para y el modelo sigue desde ahí
 * sabiendo qué está ya hecho. Al final el modelo mira la página y contesta.
 *
 * Nunca se aprende una ruta con pagos ni con pasos que no se pueden deshacer (pagar,
 * comprar, confirmar, reservar, borrar, darse de baja…), ni con contraseñas del vault, ni
 * con código propio (exec_js). Los pasos repetidos pasan por el mismo control de permisos
 * que los del modelo.
 *
 * Se apaga con PA_RUTAS_APRENDIDAS=0.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Una llamada de herramienta del turno, con sus argumentos (para aprender rutas). */
export interface TrailCall {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  warn?: string;
  /** Refs del snapshot que devolvió esta llamada (`e12` → «Buscar»), para traducirlos. */
  refs?: Record<string, string>;
}

/** Un ref de snapshot (`e12`, `@e12`, `[e12]`, `[data-pa-ref="e12"]`). */
const REF = /^\s*(?:\[?@?(e\d{1,6})\]?|\[data-pa-ref=["']?(e\d{1,6})["']?\])\s*$/i;

/**
 * Los refs de un snapshot con su nombre visible: `e12[button] "Buscar"` → e12: Buscar.
 * Un ref vale solo en la página donde se puso (es un contador), así que una ruta nunca
 * lo guarda: lo cambia por el texto del elemento, que el clic también entiende.
 */
export function refsOf(snapshot: string): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 0;
  for (const m of snapshot.matchAll(/(?:^|\s)@?(e\d{1,6})\[[^\]\n]*\][^"\n]*"([^"\n]{1,80})"/gm)) {
    const ref = (m[1] as string).toLowerCase();
    if (!(ref in out)) out[ref] = (m[2] as string).trim();
    if (++n >= 400) break;
  }
  return out;
}

/** Un paso de una ruta: los argumentos de la herramienta `browser`, con huecos {{pN}}. */
export interface RouteStep {
  args: Record<string, string | number | boolean>;
}

export interface Route {
  id: string;
  /** La petición con huecos: «mira el precio de {{p1}} en mercadona». */
  template: string;
  params: string[];
  steps: RouteStep[];
  learnedAt: string;
  uses: number;
  fails: number;
  lastUsedAt?: string;
}

/** Una ruta que encaja con la petición de ahora, con sus huecos rellenos. */
export interface RouteMatch {
  route: Route;
  values: Record<string, string>;
  steps: RouteStep[];
}

/** Acciones del navegador que se pueden repetir. */
const REPLAYABLE = new Set([
  'open',
  'click',
  'fill',
  'choose',
  'press',
  'wait',
  'wait_for',
  'back',
]);
/** Acciones que solo miran: no forman parte de la ruta (el modelo mira al final). */
const LOOKS = new Set(['snapshot', 'screenshot']);
/** Herramientas que solo leen o hablan: pueden ir en el turno sin estropear la ruta. */
const QUIET_TOOLS = new Set(['done', 'memory', 'skills', 'cargar_herramienta', 'web', 'fetch']);
/** Argumentos que se guardan de cada paso (lo demás no hace falta para repetirlo). */
const KEPT_ARGS = [
  'action',
  'url',
  'selector',
  'text',
  'option',
  'key',
  'with',
  'timeoutMs',
  'expect',
  'visible',
];

/**
 * Pagos y pasos que no se deshacen. Un turno que tocó cualquiera de estas cosas no se
 * aprende: repetirlo solo, sin que el modelo lo piense, sería actuar sin permiso nuevo.
 */
export const IRREVERSIBLE =
  /pag(?:ar|o|ue)|compr(?:ar|a ya|ar ahora)|finaliz|confirm|tramit|realizar pedido|hacer (?:el )?pedido|enviar pedido|reserv|suscrib|eliminar|borrar|cancel|dar(?:se)? de baja|firmar|transferen|bizum|checkout|\bpay\b|payment|place order|buy now|purchase|\bdelete\b|unsubscribe|submit order|\border now\b/i;

/** Cuántas rutas se guardan como mucho (las más viejas se van). */
const MAX_ROUTES = 40;
/** Pasos mínimos que hacen algo para que merezca la pena una ruta. */
const MIN_ACTING_STEPS = 2;
/** Una ruta que falla dos veces seguidas se olvida. */
const MAX_FAILS = 2;

/** ¿Están encendidas? (PA_RUTAS_APRENDIDAS=0 las apaga.) */
export function routesOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PA_RUTAS_APRENDIDAS ?? '').trim() !== '0';
}

/** Minúsculas y sin tildes, carácter a carácter: la posición i del resultado es la i del original. */
function foldEach(text: string): string {
  let out = '';
  for (const ch of text) {
    const folded = ch
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    // Un carácter que al plegarse cambia de largo se deja tal cual (en minúsculas si se puede).
    out +=
      folded.length === ch.length
        ? folded
        : ch.toLowerCase().length === ch.length
          ? ch.toLowerCase()
          : ch;
  }
  return out;
}

const tidy = (text: string): string =>
  text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?¡¿…]+$/u, '')
    .trim();
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function plainArgs(
  args: Record<string, unknown>,
): Record<string, string | number | boolean> | null {
  const out: Record<string, string | number | boolean> = {};
  for (const key of KEPT_ARGS) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      out[key] = value;
    else return null;
  }
  return out;
}

/** Lo que dice un paso, para buscar pagos y pasos que no se deshacen. */
function stepWords(args: Record<string, unknown>): string {
  const url = typeof args.url === 'string' ? args.url : '';
  return [args.selector, args.text, args.option, args.key, args.expect, url]
    .filter((v): v is string => typeof v === 'string')
    .join(' \n ');
}

/**
 * La ruta que se puede aprender de un turno que salió bien, o null. `prompt` es lo que
 * Nico pidió y `trail` lo que se hizo, en orden.
 */
export function learnRoute(
  prompt: string,
  trail: readonly TrailCall[],
  now = new Date(),
): Route | null {
  const asked = tidy(prompt);
  if (asked.length < 6 || asked.length > 300) return null;
  const steps: Array<Record<string, string | number | boolean>> = [];
  const refs: Record<string, string> = {};
  for (const call of trail) {
    if (call.refs) Object.assign(refs, call.refs);
    if (call.tool !== 'browser') {
      if (QUIET_TOOLS.has(call.tool)) continue;
      return null; // otra herramienta que hace cosas: la tarea no es solo de navegador
    }
    if (!call.ok || call.warn) return null;
    const action = String(call.args.action ?? '');
    if (LOOKS.has(action)) continue;
    if (!REPLAYABLE.has(action)) return null;
    if (call.args.secret_key !== undefined) return null;
    if (IRREVERSIBLE.test(stepWords(call.args))) return null;
    const args = plainArgs(call.args);
    if (!args) return null;
    for (const key of ['selector', 'with'] as const) {
      const value = args[key];
      if (typeof value !== 'string') continue;
      const ref = REF.exec(value);
      if (!ref) {
        if (/data-pa-ref/i.test(value)) return null;
        continue;
      }
      const name = refs[(ref[1] ?? ref[2] ?? '').toLowerCase()];
      // Sin nombre visible (o es una dirección) no hay forma fiable de encontrarlo otra vez.
      if (!name || /^(?:\/|https?:)/i.test(name)) return null;
      if (IRREVERSIBLE.test(name)) return null;
      args[key] = name;
    }
    steps.push(args);
  }
  if (
    steps.filter((s) => s.action !== 'open' && s.action !== 'wait' && s.action !== 'wait_for')
      .length < MIN_ACTING_STEPS
  )
    return null;
  if (steps[0]?.action !== 'open') return null; // una ruta empieza en una página conocida

  // Huecos: lo que Nico escribió y luego se tecleó en la página.
  const foldedAsk = foldEach(asked);
  const params: string[] = [];
  const spans: Array<{ start: number; end: number; name: string; value: string }> = [];
  for (const step of steps) {
    for (const key of ['text', 'option'] as const) {
      const value = step[key];
      if (typeof value !== 'string' || value.trim().length < 2) continue;
      const literal = value.trim();
      const at = foldedAsk.indexOf(foldEach(literal));
      if (at < 0) continue;
      const end = at + literal.length;
      if (foldedAsk.indexOf(foldEach(literal), at + 1) >= 0) continue; // ambiguo: sale dos veces
      const existing = spans.find((s) => s.start === at && s.end === end);
      const name = existing?.name ?? `p${spans.length + 1}`;
      if (!existing) {
        if (spans.some((s) => at < s.end && end > s.start)) continue;
        spans.push({ start: at, end, name, value: literal });
        params.push(name);
      }
    }
  }
  const templated = steps.map((step) => {
    const args: Record<string, string | number | boolean> = { ...step };
    for (const span of spans) {
      for (const key of ['text', 'option'] as const) {
        if (
          typeof args[key] === 'string' &&
          foldEach(String(args[key]).trim()) === foldEach(span.value)
        )
          args[key] = `{{${span.name}}}`;
      }
      if (typeof args.url === 'string') {
        const url = args.url;
        const encoded = [
          encodeURIComponent(span.value),
          span.value.replace(/\s+/g, '+'),
          span.value,
        ];
        for (const form of encoded) {
          const i = url.toLowerCase().indexOf(form.toLowerCase());
          if (i >= 0 && form) {
            args.url = `${url.slice(0, i)}{{${span.name}|url}}${url.slice(i + form.length)}`;
            break;
          }
        }
      }
    }
    return { args };
  });
  let template = '';
  let position = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    template += `${asked.slice(position, span.start)}{{${span.name}}}`;
    position = span.end;
  }
  template += asked.slice(position);
  return {
    id: randomUUID(),
    template,
    params,
    steps: templated,
    learnedAt: now.toISOString(),
    uses: 0,
    fails: 0,
  };
}

/** La expresión que reconoce peticiones con la forma de la plantilla. */
function templateRegex(template: string): RegExp {
  const parts = template.split(/(\{\{p\d+\}\})/);
  const body = parts
    .map((part) =>
      /^\{\{p\d+\}\}$/.test(part) ? '(.+?)' : escapeRe(foldEach(part)).replace(/\s+/g, '\\s+'),
    )
    .join('');
  return new RegExp(`^${body}$`, 'd');
}

/** La ruta que encaja con esta petición, con sus huecos rellenos, o null. */
export function matchRoute(prompt: string, routes: readonly Route[]): RouteMatch | null {
  const asked = tidy(prompt);
  const folded = foldEach(asked);
  let best: { match: RouteMatch; literal: number } | null = null;
  for (const route of routes) {
    const names = [...route.template.matchAll(/\{\{(p\d+)\}\}/g)].map((m) => m[1] as string);
    const found = templateRegex(route.template).exec(folded);
    if (!found) continue;
    const values: Record<string, string> = {};
    let ok = true;
    names.forEach((name, i) => {
      const span = found.indices?.[i + 1];
      const value = span ? asked.slice(span[0], span[1]).trim() : '';
      if (!value || value.length > 200 || (values[name] !== undefined && values[name] !== value))
        ok = false;
      values[name] = value;
    });
    if (!ok) continue;
    const literal = route.template.replace(/\{\{p\d+\}\}/g, '').length;
    if (!best || literal > best.literal) {
      best = { match: { route, values, steps: renderSteps(route, values) }, literal };
    }
  }
  return best?.match ?? null;
}

/** Los pasos de la ruta con los huecos rellenos. */
export function renderSteps(route: Route, values: Record<string, string>): RouteStep[] {
  return route.steps.map((step) => {
    const args: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(step.args)) {
      args[key] =
        typeof value === 'string'
          ? value.replace(/\{\{(p\d+)(\|url)?\}\}/g, (whole, name: string, url?: string) => {
              const v = values[name];
              if (v === undefined) return whole;
              return url ? encodeURIComponent(v) : v;
            })
          : value;
    }
    return { args };
  });
}

/** Cómo se cuenta un paso en una línea («open https://…», «fill #buscar "leche"»). */
export function describeStep(args: Record<string, unknown>): string {
  const action = String(args.action ?? '');
  const target = args.url ?? args.selector ?? args.with ?? args.key ?? '';
  const text = args.text !== undefined ? ` "${String(args.text)}"` : '';
  const option = args.option !== undefined ? ` → "${String(args.option)}"` : '';
  return `${action} ${String(target)}${text}${option}`.trim();
}

/** Las rutas guardadas, en un fichero JSON del estado de Asistenta. */
export class RouteStore {
  readonly #file: string;
  #routes: Route[] | null = null;

  constructor(file: string) {
    this.#file = file;
  }

  list(): Route[] {
    if (this.#routes) return this.#routes;
    try {
      const raw = existsSync(this.#file) ? JSON.parse(readFileSync(this.#file, 'utf8')) : [];
      this.#routes = Array.isArray(raw) ? raw.filter(isRoute) : [];
    } catch {
      this.#routes = [];
    }
    return this.#routes;
  }

  match(prompt: string): RouteMatch | null {
    return matchRoute(prompt, this.list());
  }

  /** Guarda una ruta nueva; una con la misma plantilla se sustituye. */
  learn(route: Route): void {
    const key = foldEach(route.template);
    const kept = this.list().filter((r) => foldEach(r.template) !== key);
    kept.push(route);
    this.#routes = kept.slice(-MAX_ROUTES);
    this.#save();
  }

  /** Apunta cómo fue una repetición: bien suma un uso; dos fallos seguidos la olvidan. */
  outcome(id: string, ok: boolean, now = new Date()): void {
    const routes = this.list();
    const route = routes.find((r) => r.id === id);
    if (!route) return;
    route.lastUsedAt = now.toISOString();
    if (ok) {
      route.uses += 1;
      route.fails = 0;
    } else {
      route.fails += 1;
    }
    this.#routes = routes.filter((r) => r.fails < MAX_FAILS);
    this.#save();
  }

  /** Olvida una ruta (por número de la lista, empezando en 1) o todas. */
  forget(which: number | 'all'): number {
    const routes = this.list();
    const before = routes.length;
    this.#routes = which === 'all' ? [] : routes.filter((_, i) => i !== which - 1);
    this.#save();
    return before - this.#routes.length;
  }

  #save(): void {
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#routes ?? [], null, 2));
      renameSync(tmp, this.#file);
    } catch {
      // Sin disco no hay rutas: Asistenta sigue funcionando como siempre.
    }
  }
}

function isRoute(value: unknown): value is Route {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<Route>;
  return (
    typeof r.id === 'string' &&
    typeof r.template === 'string' &&
    Array.isArray(r.steps) &&
    r.steps.every((s) => s && typeof s === 'object' && typeof (s as RouteStep).args === 'object') &&
    typeof r.uses === 'number' &&
    typeof r.fails === 'number'
  );
}

/** La plantilla tal como se le enseña a Nico: los huecos como «…». */
export function shownTemplate(template: string): string {
  return template.replace(/\{\{p\d+\}\}/g, '…');
}

/**
 * Después de un turno: apunta cómo fue la ruta repetida, o aprende una nueva. Devuelve
 * la línea para Nico cuando aprende una ruta nueva (para que sepa que la próxima irá más
 * rápido), o null.
 *
 * Solo se aprende de un turno limpio: sin error, sin nada bloqueado por permisos y sin
 * que el revisor del «hecho» haya avisado de algo.
 */
export function routeAfterTurn(
  store: RouteStore,
  asked: string,
  result: {
    error: string | null;
    blocked: number;
    trail?: readonly TrailCall[];
    route?: { id: string; status: string };
  },
  doneNote: string | null,
  now = new Date(),
): string | null {
  const clean = result.error === null && result.blocked === 0 && !doneNote;
  if (result.route) {
    store.outcome(result.route.id, clean && result.route.status === 'ok', now);
    if (result.route.status === 'ok') return null;
  }
  if (!clean || !result.trail?.length) return null;
  const learned = learnRoute(asked, result.trail, now);
  if (!learned) return null;
  const known = store.list().some((r) => foldEach(r.template) === foldEach(learned.template));
  store.learn(learned);
  if (known) return null;
  return `🧭 Apuntado: la próxima vez que me pidas «${shownTemplate(learned.template)}» repetiré estos pasos yo sola, más rápido. Si algo cambia en la página, sigo como siempre.`;
}
