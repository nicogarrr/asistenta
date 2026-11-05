/**
 * Traer a Asistenta lo que ChatGPT o Grok ya saben de Nico, como hace Grok («Settings →
 * Import»): Asistenta le da un texto para pegar en el otro asistente, Nico le pega la
 * respuesta y, antes de guardar nada, ve la lista y dice «sí», «no» o «sí menos 3».
 *
 * Va al mismo perfil que «mi dentista es…» (snapshot.ts), con el prefijo «[importado]» para
 * saber de dónde vino. Lo que ya estaba no se duplica, y lo que contradice algo que Nico dijo
 * él mismo no pisa su palabra: se queda fuera y se le dice.
 */
import { foldAccents } from '../text.js';
import { alreadySaid, factKey } from './owner-facts.js';

/** Prefijo de las entradas que vinieron de otro asistente. */
export const IMPORT_PREFIX = '[importado]';

/** La primera línea que se le pide al otro asistente: así Asistenta reconoce lo pegado. */
export const IMPORT_HEADER = 'MEMORIA PARA ASISTENTA';

/** Cuántos datos como mucho de una vez (el perfil es corto: va en cada mensaje). */
export const IMPORT_MAX = 40;

/** Cuánto tiempo espera el «sí» después de enseñar la lista. */
export const IMPORT_TTL_MS = 30 * 60_000;

/** Lo que Nico copia y pega en ChatGPT o Grok. */
export const IMPORT_PROMPT = `${IMPORT_HEADER}
Escribe todo lo que sabes de mí y recuerdas de nuestras conversaciones que le sirva a mi asistente personal: nombre, dónde vivo, trabajo, familia y nombres, fechas importantes (cumpleaños), salud y alergias, gustos, equipo, aficiones, rutinas, proyectos en marcha y cómo prefiero que me hablen.
Reglas: empieza la respuesta con la línea «${IMPORT_HEADER}»; luego una línea por dato, empezando por «- », en español y en primera persona, como si lo dijera yo («- Vivo en Gijón», «- Mi hermana se llama Laura»); nada de contraseñas, claves ni números de cuenta; si no estás seguro de algo, no lo pongas.`;

/** ¿Es lo pegado del otro asistente (empieza por la cabecera, con o sin adornos)? */
export function isImportPaste(text: string): boolean {
  const first = foldAccents(text.trim().split('\n')[0] ?? '')
    .replace(/[*_#`>«»"':]/g, '')
    .trim();
  return first === foldAccents(IMPORT_HEADER) && text.trim().split('\n').length >= 2;
}

/** Algo que no se guarda nunca: claves, cuentas, tarjetas. */
const SECRET =
  /\b(?:contrase[nñ]a|password|clave|pin|token|api[ _-]?key|iban|tarjeta|cvv|n[uú]mero de cuenta)\b|\b(?:\d[ -]?){12,}\b|\bES\d{2}(?:\s?\d{4}){5}\b/i;

export interface ImportPlan {
  /** Los que se apuntarían, en orden. */
  nuevos: string[];
  /** Ya estaban apuntados tal cual. */
  repetidos: number;
  /** Contradicen algo que Nico dijo él mismo (su palabra manda). */
  choques: string[];
  /** Líneas que no parecen un dato (preguntas, muy largas, claves…). */
  descartados: number;
  /** Datos que no caben en el perfil sin echar otros. */
  sinSitio: number;
}

/** Una línea de la lista, limpia: sin viñeta, sin negritas, con punto final fuera. */
function cleanLine(line: string): string {
  return line
    .replace(/^\s*(?:[-•*·–]|\d{1,2}[.)])\s*/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;]+$/, '');
}

/**
 * Lo pegado → lo que se apuntaría. `existing` son las entradas del perfil; `room` los
 * caracteres que quedan libres en él (lo que no quepa no se apunta: si no, echaría lo más
 * antiguo que Nico dijo él mismo).
 */
export function planImport(
  text: string,
  existing: readonly string[],
  room = Number.POSITIVE_INFINITY,
): ImportPlan {
  const lines = text.split('\n').slice(isImportPaste(text) ? 1 : 0);
  const plan: ImportPlan = { nuevos: [], repetidos: 0, choques: [], descartados: 0, sinSitio: 0 };
  const seen = new Set<string>();
  const own = existing.filter((e) => e.trim());
  let left = room;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const line = cleanLine(raw);
    if (!line) continue;
    if (
      line.length < 4 ||
      line.length > 180 ||
      /[?¿]/.test(line) ||
      SECRET.test(line) ||
      foldAccents(line) === foldAccents(IMPORT_HEADER) ||
      /:$/.test(raw.trim())
    ) {
      plan.descartados++;
      continue;
    }
    const fact = line.charAt(0).toUpperCase() + line.slice(1);
    const key = foldAccents(fact);
    if (seen.has(key)) continue;
    seen.add(key);
    if (alreadySaid(own, fact)) {
      plan.repetidos++;
      continue;
    }
    // «Mi dentista es el Dr. López» con el Dr. García ya apuntado: lo que Nico dijo manda.
    const fk = factKey(fact);
    if (fk && own.some((e) => factKey(e) === fk)) {
      plan.choques.push(fact);
      continue;
    }
    if (plan.nuevos.length >= IMPORT_MAX) {
      plan.sinSitio++;
      continue;
    }
    const cost = IMPORT_PREFIX.length + 1 + fact.length + 3;
    if (cost > left) {
      plan.sinSitio++;
      continue;
    }
    left -= cost;
    plan.nuevos.push(fact);
  }
  return plan;
}

/** La lista para revisar antes de guardar. */
export function importPreview(plan: ImportPlan): string {
  const notes: string[] = [];
  if (plan.repetidos) notes.push(`${plan.repetidos} ya los tenía`);
  if (plan.choques.length) {
    const shown = plan.choques
      .slice(0, 3)
      .map((c) => `«${c}»`)
      .join(', ');
    notes.push(
      `${plan.choques.length} chocan con lo que tú me dijiste y me quedo con lo tuyo (${shown}${plan.choques.length > 3 ? '…' : ''})`,
    );
  }
  if (plan.sinSitio) notes.push(`${plan.sinSitio} no caben en tu perfil`);
  if (plan.descartados) notes.push(`${plan.descartados} líneas no parecían un dato`);
  const tail = notes.length ? `\n(${notes.join('; ')}.)` : '';
  if (plan.nuevos.length === 0) {
    return `No hay nada nuevo que apuntar.${tail}`;
  }
  const list = plan.nuevos.map((f, i) => `${i + 1}. ${f}`).join('\n');
  return `He encontrado ${plan.nuevos.length} ${plan.nuevos.length === 1 ? 'dato nuevo' : 'datos nuevos'}:\n${list}${tail}\n\n¿Los apunto? Responde «sí», «no» o «sí menos 3, 5».`;
}

/** Los números que se dicen: «3, 5 y 7», «3 5», «del 2 al 4». */
function numbersIn(text: string, max: number): number[] | null {
  const out = new Set<number>();
  for (const m of text.matchAll(/(\d{1,2})\s*(?:-|al?)\s*(\d{1,2})|(\d{1,2})/g)) {
    if (m[1] && m[2]) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.add(i);
    } else if (m[3]) out.add(Number(m[3]));
  }
  const nums = [...out];
  if (nums.length === 0 || nums.some((n) => n < 1 || n > max)) return null;
  return nums;
}

/**
 * La respuesta a la lista: los índices (desde 0) que se apuntan, [] si «no», null si no
 * es una respuesta a esto (entonces el mensaje sigue su camino normal).
 */
export function importAnswer(text: string, count: number): number[] | null {
  const t = foldAccents(text.trim())
    .replace(/[.!¡]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!t || t.length > 80) return null;
  const all = Array.from({ length: count }, (_, i) => i);
  if (/^(?:no|nada|ninguno|cancela|cancelar|dejalo|olvidalo|mejor no)$/.test(t)) return [];
  if (
    /^(?:si|vale|ok|venga|claro|dale|todos|si,? todos|apuntalos|guardalos|si,? apuntalos)$/.test(t)
  )
    return all;
  const minus =
    /^(?:si,?\s+)?(?:todos\s+)?(?:menos|excepto|salvo|quita|sin)\s+(?:el\s+|los\s+)?(.+)$/.exec(t);
  if (minus?.[1]) {
    const drop = numbersIn(minus[1], count);
    return drop ? all.filter((i) => !drop.includes(i + 1)) : null;
  }
  const only = /^(?:si,?\s+)?(?:solo|solamente|nada mas)\s+(?:el\s+|los\s+)?(.+)$/.exec(t);
  if (only?.[1]) {
    const keep = numbersIn(only[1], count);
    return keep ? keep.map((n) => n - 1).sort((a, b) => a - b) : null;
  }
  return null;
}

/** La confirmación después de guardar. */
export function importDoneLine(saved: number): string {
  if (saved === 0) return 'Vale, no apunto nada.';
  return `📝 Apuntados ${saved} ${saved === 1 ? 'dato' : 'datos'} de tu otro asistente. «¿Qué sabes de mí?» los enseña y «olvida lo de …» borra uno.`;
}

/** La lista enseñada, esperando el «sí» (una por chat, caduca a los 30 min). */
export class ImportsPendientes {
  readonly #byChat = new Map<string, { facts: readonly string[]; at: number }>();

  set(chat: string, facts: readonly string[], at = Date.now()): void {
    if (facts.length === 0) this.#byChat.delete(chat);
    else this.#byChat.set(chat, { facts, at });
  }

  peek(chat: string, now = Date.now()): readonly string[] | null {
    const p = this.#byChat.get(chat);
    if (!p) return null;
    if (now - p.at > IMPORT_TTL_MS) {
      this.#byChat.delete(chat);
      return null;
    }
    return p.facts;
  }

  clear(chat: string): void {
    this.#byChat.delete(chat);
  }
}
