/**
 * F11 «enseñar con demostración»: núcleo puro, sin navegador.
 *
 * Convierte los eventos que grabaría un listener del navegador (navegar, clic,
 * escribir, enviar) en pasos reproducibles con selectores estables, y los
 * reproduce en el mismo orden. Apagado por defecto: solo con PA_TEACH_DEMO=1.
 *
 * Seguridad (solo más estricto):
 * - el valor de un campo sensible (contraseña, tarjeta, CVV, IBAN, código de un
 *   solo uso…) NUNCA se guarda: queda un marcador de almacén `{{vault:<host>:<campo>}}`
 *   que se resuelve al reproducir, por la Gate, nunca aquí;
 * - si ese mismo valor aparece escrito en otro campo, también se tapa;
 * - navegar a un host de la lista «nunca aprobar» aborta la grabación entera y
 *   también la reproducción;
 * - solo http/https; la URL se guarda sin usuario ni contraseña.
 * Paso 2: `demoToPlaybook` guarda lo aprendido en el playbook del gestor
 * (selectores + nombres de clave), nunca valores. Paso 3: `/learn web <url>`
 * lo conecta al navegador (src/teach-demo-web.ts).
 */
import {
  canonicalPlaybookDomain,
  MAX_PLAYBOOK_LINES_PER_SECTION,
  type Playbook,
  validatePlaybook,
} from './gestor/playbooks.js';
import { normalizeHostname, urlHostname } from './text.js';

export interface DemoTarget {
  testId?: string;
  id?: string;
  name?: string;
  ariaLabel?: string;
  role?: string;
  text?: string;
  tag?: string;
  inputType?: string;
  autocomplete?: string;
}

export type DemoEvent =
  | { type: 'navigate'; url: string }
  | { type: 'click'; target: DemoTarget }
  | { type: 'input'; target: DemoTarget; value: string }
  | { type: 'submit'; target: DemoTarget };

export type DemoStep =
  | { action: 'goto'; url: string }
  | { action: 'click'; selector: string }
  | { action: 'fill'; selector: string; param: string }
  | { action: 'fill'; selector: string; secret: string }
  | { action: 'submit'; selector: string };

export interface DemoPlaybook {
  steps: DemoStep[];
  /** Parámetros de los campos normales, con el valor de la demostración como ejemplo. */
  params: Record<string, string>;
}

export type DemoResult = ({ ok: true } & DemoPlaybook) | { ok: false; reason: string };

/** Acción concreta de una reproducción (lo que se pasaría al navegador por la Gate). */
export type DemoAction =
  | { action: 'goto'; url: string }
  | { action: 'click'; selector: string }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'fill'; selector: string; secret: string }
  | { action: 'submit'; selector: string };

export const MAX_DEMO_EVENTS = 200;
export const TEACH_DEMO_OFF =
  'Enseñar con demostración está desactivado: PA_TEACH_DEMO=1 para activarlo.';

/** true solo con PA_TEACH_DEMO=1 (apagado por defecto). */
export function teachDemoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PA_TEACH_DEMO ?? '').trim() === '1';
}

const SENSITIVE_WORDS =
  /pass|contrase|clave|pwd|cvv|cvc|csc|card|tarjeta|iban|cuenta|\bpin\b|otp|2fa|verif|token|secret|dni|nif|ssn/i;
const SENSITIVE_AUTOCOMPLETE = /^(current-password|new-password|one-time-code|cc-.+)$/i;

/** Campo cuyo valor nunca se graba. Ante la duda, sensible. */
export function isSensitiveField(t: DemoTarget): boolean {
  if ((t.inputType ?? '').toLowerCase() === 'password') return true;
  if (SENSITIVE_AUTOCOMPLETE.test((t.autocomplete ?? '').trim())) return true;
  const words = [t.name, t.id, t.ariaLabel, t.testId].filter(Boolean).join(' ');
  return SENSITIVE_WORDS.test(words.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

const quote = (v: string): string => JSON.stringify(v);
const SAFE_ID = /^[A-Za-z][\w-]{0,63}$/;
/** Ids generados por frameworks (`ember123`, `:r5:`, `a1b2c3d4…`) no sirven al reproducir. */
const looksGenerated = (id: string): boolean => !SAFE_ID.test(id) || /\d{3,}/.test(id);

/** Selector estable, del más fiable al menos; null si no hay nada estable. */
export function stableSelector(t: DemoTarget): string | null {
  if (t.testId?.trim()) return `[data-testid=${quote(t.testId.trim())}]`;
  if (t.id && !looksGenerated(t.id)) return `#${t.id}`;
  const tag = /^[a-z][a-z0-9-]*$/i.test(t.tag ?? '') ? (t.tag as string).toLowerCase() : '';
  if (t.name?.trim()) return `${tag}[name=${quote(t.name.trim())}]`;
  if (t.ariaLabel?.trim()) return `${tag}[aria-label=${quote(t.ariaLabel.trim())}]`;
  const text = t.text?.trim().replace(/\s+/g, ' ');
  if (text && text.length <= 80) return `${t.role?.trim() || tag || '*'} >> text=${quote(text)}`;
  return null;
}

function hostDenied(host: string, denied: readonly string[]): boolean {
  return denied.some((d) => {
    const h = normalizeHostname(d.trim());
    return h !== '' && (host === h || host.endsWith(`.${h}`));
  });
}

/** URL navegable y permitida, sin credenciales; si no, el motivo. */
function checkUrl(raw: string, denied: readonly string[]): { url: string } | { reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: 'una dirección no es una URL válida' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { reason: `solo se graban páginas http/https (${url.protocol})` };
  }
  const host = urlHostname(url.toString()) ?? '';
  if (hostDenied(host, denied)) return { reason: `${host} está en la lista «nunca aprobar»` };
  url.username = '';
  url.password = '';
  return { url: url.toString() };
}

function paramName(t: DemoTarget, taken: Record<string, string>): string {
  const base =
    (t.name || t.id || t.ariaLabel || 'campo')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'campo';
  let name = base;
  for (let i = 2; name in taken; i++) name = `${base}_${i}`;
  return name;
}

/** Eventos simulados de una demostración → playbook. Aborta entero si algo no es seguro. */
export function recordDemo(
  events: readonly DemoEvent[],
  opts: { deniedHosts?: readonly string[]; env?: NodeJS.ProcessEnv } = {},
): DemoResult {
  if (!teachDemoEnabled(opts.env)) return { ok: false, reason: TEACH_DEMO_OFF };
  if (events.length > MAX_DEMO_EVENTS) {
    return { ok: false, reason: `demasiados pasos (máximo ${MAX_DEMO_EVENTS})` };
  }
  const denied = opts.deniedHosts ?? [];
  const secrets = new Set<string>();
  for (const e of events) {
    if (e.type === 'input' && isSensitiveField(e.target) && e.value) secrets.add(e.value);
  }
  const steps: DemoStep[] = [];
  const params: Record<string, string> = {};
  let host = '';
  for (const [i, e] of events.entries()) {
    if (e.type === 'navigate') {
      const checked = checkUrl(e.url, denied);
      if ('reason' in checked)
        return { ok: false, reason: `Grabación abortada: ${checked.reason}.` };
      host = urlHostname(checked.url) ?? '';
      const last = steps.at(-1);
      if (last?.action === 'goto') last.url = checked.url;
      else steps.push({ action: 'goto', url: checked.url });
      continue;
    }
    const selector = stableSelector(e.target);
    if (!selector) {
      return { ok: false, reason: `No se pudo identificar el elemento del paso ${i + 1}.` };
    }
    if (e.type !== 'input') {
      steps.push({ action: e.type, selector });
      continue;
    }
    const last = steps.at(-1);
    const sameField = last?.action === 'fill' && last.selector === selector;
    if (isSensitiveField(e.target) || secrets.has(e.value)) {
      const field = paramName(e.target, {});
      const step: DemoStep = {
        action: 'fill',
        selector,
        secret: `{{vault:${host || 'web'}:${field}}}`,
      };
      if (sameField) steps[steps.length - 1] = step;
      else steps.push(step);
      continue;
    }
    if (sameField && 'param' in last) {
      params[last.param] = e.value;
      continue;
    }
    const name = paramName(e.target, params);
    params[name] = e.value;
    if (sameField) steps[steps.length - 1] = { action: 'fill', selector, param: name };
    else steps.push({ action: 'fill', selector, param: name });
  }
  if (!steps.length) return { ok: false, reason: 'La demostración no tiene pasos.' };
  return { ok: true, steps, params };
}

/** Playbook + valores → acciones en el mismo orden. Los secretos siguen como marcador. */
export function replayDemo(
  playbook: DemoPlaybook,
  values: Record<string, string> = {},
  opts: { deniedHosts?: readonly string[]; env?: NodeJS.ProcessEnv } = {},
): DemoAction[] {
  if (!teachDemoEnabled(opts.env)) throw new Error(TEACH_DEMO_OFF);
  return playbook.steps.map((step): DemoAction => {
    if (step.action === 'goto') {
      const checked = checkUrl(step.url, opts.deniedHosts ?? []);
      if ('reason' in checked) throw new Error(`Reproducción abortada: ${checked.reason}.`);
      return { action: 'goto', url: checked.url };
    }
    if (step.action !== 'fill' || 'secret' in step) return { ...step };
    const value = values[step.param] ?? playbook.params[step.param];
    if (value === undefined) throw new Error(`Falta el valor de «${step.param}».`);
    return { action: 'fill', selector: step.selector, value };
  });
}

export type DemoPlaybookResult = { ok: true; playbook: Playbook } | { ok: false; reason: string };

/**
 * F11 paso 2 (puro): demostración grabada → playbook por dominio del gestor.
 * Solo guarda lo que se reutiliza: los selectores que funcionaron con el
 * NOMBRE del parámetro y, para campos sensibles, el NOMBRE de la clave del
 * almacén. Los valores de ejemplo de la demostración (correo, búsquedas…) y
 * los secretos no se escriben nunca. Un solo dominio por playbook: si la
 * demostración cambia de dominio, o `existing` es de otro, se rechaza. Fusiona
 * con `existing` sin duplicar (sus líneas primero) y pasa por
 * `validatePlaybook`: lo que no cabe se rechaza, no se recorta en silencio.
 */
export function demoToPlaybook(
  demo: DemoPlaybook,
  opts: { env?: NodeJS.ProcessEnv; now?: Date; existing?: Playbook | null } = {},
): DemoPlaybookResult {
  if (!teachDemoEnabled(opts.env)) return { ok: false, reason: TEACH_DEMO_OFF };
  let domain: string | null = null;
  const login: string[] = [];
  const selectores: string[] = [];
  for (const step of demo.steps) {
    if (step.action === 'goto') {
      const d = canonicalPlaybookDomain(step.url);
      if (!d)
        return { ok: false, reason: 'La demostración tiene una dirección sin dominio válido.' };
      if (domain && d !== domain) {
        return {
          ok: false,
          reason: `La demostración pasa de ${domain} a ${d}: un playbook es de un solo dominio.`,
        };
      }
      domain = d;
      continue;
    }
    if (step.action === 'click') selectores.push(`clic: ${step.selector}`);
    else if (step.action === 'submit') selectores.push(`enviar: ${step.selector}`);
    else if ('param' in step) selectores.push(`campo «${step.param}»: ${step.selector}`);
    else {
      const field = /^\{\{vault:[^:]*:([^}]+)\}\}$/.exec(step.secret)?.[1] ?? 'secreto';
      login.push(
        `campo secreto ${step.selector}: clave del almacén vault:${domain ?? 'web'}:${field}`,
      );
    }
  }
  if (!domain) return { ok: false, reason: 'La demostración no abre ninguna página.' };
  const ex = opts.existing ?? null;
  if (ex && ex.domain !== domain) {
    return { ok: false, reason: `El playbook existente es de ${ex.domain}, no de ${domain}.` };
  }
  const merge = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];
  const playbook: Playbook = {
    domain,
    updatedAt: (opts.now ?? new Date()).toISOString(),
    login: merge(ex?.login ?? [], login),
    selectores: merge(ex?.selectores ?? [], selectores),
    quirks: [...(ex?.quirks ?? [])],
  };
  if (playbook.selectores.length > MAX_PLAYBOOK_LINES_PER_SECTION) {
    return {
      ok: false,
      reason: `La demostración deja ${playbook.selectores.length} selectores (máximo ${MAX_PLAYBOOK_LINES_PER_SECTION}): enséñala en partes más cortas.`,
    };
  }
  const invalid = validatePlaybook(playbook);
  return invalid ? { ok: false, reason: invalid } : { ok: true, playbook };
}
