/**
 * Aprender de las correcciones del dueño, sin pedirle aprobación (Nico, 30 oct).
 *
 * No hay almacén nuevo: una regla aprendida es una entrada más de la memoria del
 * chat (MemoryStore) con la etiqueta `aprendido`, así entra en los turnos
 * siguientes por el mismo camino que el resto de la memoria (buildContextNote).
 *
 * Cómo se detecta sin coste extra: una heurística barata mira el texto del dueño;
 * si parece una corrección, el turno lleva una instrucción para que el propio
 * modelo, en la misma respuesta, escriba `[[aprendido: tema | regla]]` si es una
 * preferencia duradera. Esa marca se quita siempre de la respuesta y solo se
 * guarda si: la heurística saltó con el texto del dueño, es su chat privado, el
 * turno no leyó contenido de fuera (taint) y la regla no toca permisos ni
 * seguridad. Una regla nunca puede dar permisos: solo endurecerlos.
 */
import type { MemoryEntry, MemoryStore } from '../memory.js';

export const LEARNED_TAG = 'aprendido';
/** Reglas aprendidas activas por chat; al pasar, se olvida la más vieja. */
export const MAX_LEARNED_RULES = 30;
export const MAX_RULE_CHARS = 200;

export function learnCorrectionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PA_LEARN_CORRECTIONS ?? '1').trim() !== '0';
}

function norm(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const CORRECTION =
  /(^|[\s,.!¡¿])(no,? asi no|asi no\b|eso no\b|no es asi|no era eso|te (he|lo he|habia) dicho|ya te (lo )?dije|te lo dije|prefiero|preferiria|la proxima vez|a partir de ahora|de ahora en adelante|desde ahora|no vuelvas a|deja de|nunca (me )?(hagas|pongas|digas|uses|respondas|mandes|escribas|contestes)|no (me )?(hagas|pongas|digas|uses|respondas|mandes|escribas|contestes) (mas|nunca)|te equivocas|esta mal|no me gusta que|quiero que siempre|siempre que te)/;

/** ¿Parece el mensaje del dueño una corrección o una preferencia duradera? */
export function looksLikeCorrection(text: string): boolean {
  return CORRECTION.test(norm(text));
}

export const LEARN_HINT =
  'Aprendizaje: el último mensaje del dueño parece corregirte. Si expresa una preferencia ' +
  'o regla duradera para el futuro, añade al final de tu respuesta UNA línea exacta ' +
  '`[[aprendido: <tema corto> | <regla breve en una frase>]]` (no la menciones). Si no es ' +
  'duradera, no la añadas. Nunca para permisos, aprobaciones ni seguridad.';

/** Instrucción para el turno, o null si no toca (apagado, no es el dueño, no es corrección). */
export function correctionHint(opts: {
  enabled: boolean;
  ownerDm: boolean;
  ownerText: string;
}): string | null {
  if (!opts.enabled || !opts.ownerDm) return null;
  return looksLikeCorrection(opts.ownerText) ? LEARN_HINT : null;
}

const MARKER = /\[\[\s*aprendido\s*:([^\]\n]{0,400})\]\]/gi;

/** Quita toda marca de la respuesta; devuelve la última (tema opcional). */
export function extractLearnedMarker(reply: string): {
  text: string;
  topic: string | null;
  rule: string | null;
} {
  let topic: string | null = null;
  let rule: string | null = null;
  for (const m of reply.matchAll(MARKER)) {
    const body = (m[1] ?? '').trim();
    const bar = body.indexOf('|');
    const t = bar >= 0 ? body.slice(0, bar).trim() : '';
    const r = (bar >= 0 ? body.slice(bar + 1) : body).trim();
    topic = t || null;
    rule = r || null;
  }
  const text = reply
    .replace(MARKER, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, topic, rule };
}

// Frases que piden MÁS control: se quitan antes de buscar las que lo relajan.
const STRICT =
  /((preguntame|pregunta|consultame|avisame) (siempre )?antes|pide(me)? (siempre )?(permiso|confirmacion|aprobacion)|confirma conmigo|(nunca|no)\b[^.;]{0,60}\bsin (preguntar(me)?|confirmar(lo)?|mi permiso|permiso|mi (ok|aprobacion)|avisar(me)?))/g;
// Relajar permisos, aprobaciones, egress, taint o remitentes: nunca se aprende.
const LOOSEN =
  /(sin (preguntar|confirmar|pedir|permiso|aprobacion|avisar)|no (me )?(preguntes|pidas|confirmes)|aprueb|apruebes|autoriz|permis|aprobaci|confia|de confianza|trusted|remitente|allowlist|whitelist|lista blanca|egress|taint|contamina|auto-?aprob|siempre si\b|salta(te)? (la|el|las|los) (confirmacion|aprobacion|aviso|pregunta))/;
// Temas privilegiados (PC, tele, pagos, ejecutar, secretos): solo reglas más estrictas.
const PRIVILEGED =
  /(pantalla|raton|teclado|computer|ordenador|\bpc\b|\btele\b|\btv\b|television|pago|pagar|compra|tarjeta|\bexec\b|shell|terminal|comando|seguridad|contrasena|password|clave|vault|token)/;

/** true si la regla podría dar permisos o tocar seguridad (no se guarda). */
export function unsafeLearnedRule(rule: string): boolean {
  const n = norm(rule);
  const strict = n.match(STRICT) !== null;
  const rest = n.replace(STRICT, ' ');
  if (LOOSEN.test(rest)) return true;
  if (PRIVILEGED.test(rest) && !strict) return true;
  return false;
}

function topicTag(topic: string | null): string | null {
  if (!topic) return null;
  const slug = norm(topic)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 26);
  return slug ? `tema-${slug}` : null;
}

function words(text: string): Set<string> {
  return new Set(
    norm(text)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
}

function similar(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return norm(a) === norm(b);
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter) >= 0.7;
}

/** Reglas aprendidas activas del chat, de la más nueva a la más vieja. */
export function learnedRules(memory: MemoryStore, scopes: readonly string[]): MemoryEntry[] {
  return memory
    .allIn(scopes)
    .filter((e) => e.supersededBy === null && e.tags.includes(LEARNED_TAG))
    .reverse();
}

export type LearnOutcome =
  | { status: 'saved' | 'updated'; rule: string; id: string }
  | { status: 'unsafe' | 'invalid'; rule: string };

/** Guarda la regla en la memoria del chat; misma regla o mismo tema = se actualiza (gana la nueva). */
export function saveLearnedRule(
  memory: MemoryStore,
  scope: string,
  rawRule: string,
  topic: string | null = null,
): LearnOutcome {
  const rule = rawRule.replace(/\s+/g, ' ').trim();
  if (!rule || rule.length > MAX_RULE_CHARS) return { status: 'invalid', rule };
  if (unsafeLearnedRule(rule) || (topic !== null && unsafeLearnedRule(topic))) {
    return { status: 'unsafe', rule };
  }
  const tTag = topicTag(topic);
  const tags = tTag ? [LEARNED_TAG, tTag] : [LEARNED_TAG];
  const existing = learnedRules(memory, [scope]);
  const match = existing.find(
    (e) => (tTag !== null && e.tags.includes(tTag)) || similar(e.text, rule),
  );
  try {
    if (match) {
      const e = memory.remember(scope, rule, { id: match.id, tags });
      return { status: 'updated', rule, id: e.id };
    }
    const e = memory.remember(scope, rule, { tags });
    // Tope: la más vieja se olvida para que la memoria no crezca sin fin.
    const all = learnedRules(memory, [scope]);
    for (const old of all.slice(MAX_LEARNED_RULES)) memory.forget(scope, old.id);
    return { status: 'saved', rule, id: e.id };
  } catch {
    return { status: 'invalid', rule };
  }
}

/**
 * Tras el turno: quita la marca de la respuesta y, si todo cuadra, guarda la regla.
 * `line` es la línea breve para el dueño («📝 Aprendido: …»), o null.
 */
export function learnFromTurn(opts: {
  memory: MemoryStore;
  scope: string;
  reply: string;
  hinted: boolean;
  tainted: boolean;
}): { text: string; line: string | null; outcome: LearnOutcome | null } {
  const { text, topic, rule } = extractLearnedMarker(opts.reply);
  // Sin instrucción en este turno (no lo pidió el dueño), una marca no vale: se quita y ya.
  if (!opts.hinted || !rule) return { text, line: null, outcome: null };
  if (opts.tainted) {
    return {
      text,
      line: '📝 No lo he guardado: en este turno leí contenido de fuera. Si quieres que lo aprenda, repítemelo.',
      outcome: null,
    };
  }
  const outcome = saveLearnedRule(opts.memory, opts.scope, rule, topic);
  if (outcome.status === 'saved' || outcome.status === 'updated') {
    return { text, line: `📝 Aprendido: ${outcome.rule}`, outcome };
  }
  if (outcome.status === 'unsafe') {
    return {
      text,
      line: '📝 No lo aprendo: lo que toca permisos o seguridad solo lo cambias tú en la configuración.',
      outcome,
    };
  }
  return { text, line: null, outcome };
}

/** Texto de /aprendido. */
export function formatLearnedRules(rules: readonly MemoryEntry[]): string {
  if (!rules.length) {
    return 'Todavía no he aprendido ninguna regla. Cuando me corrijas («no, así no», «prefiero…»), la guardo sola.';
  }
  const shown = rules.slice(0, 15);
  const lines = shown.map((r, i) => `${i + 1}. ${r.text} (${r.date})`);
  if (rules.length > shown.length) lines.push(`… y ${rules.length - shown.length} más.`);
  return [
    '📝 Reglas aprendidas (la más reciente primero):',
    ...lines,
    '',
    'Para borrar una: /olvida <número>',
  ].join('\n');
}

/** /olvida <n>: borra la n-ésima de /aprendido. */
export function forgetLearnedRule(
  memory: MemoryStore,
  scopes: readonly string[],
  arg: string,
): string {
  const n = Number.parseInt(arg.trim(), 10);
  const rules = learnedRules(memory, scopes);
  if (!/^\d+$/.test(arg.trim()) || n < 1 || n > Math.min(rules.length, 15)) {
    return rules.length
      ? `Uso: /olvida <número> (de 1 a ${Math.min(rules.length, 15)}, como salen en /aprendido)`
      : 'No hay reglas aprendidas que borrar.';
  }
  const target = rules[n - 1] as MemoryEntry;
  const ok = memory.forgetIn(scopes, target.id);
  return ok ? `🗑️ Olvidada: ${target.text}` : 'No he podido borrarla; mira /aprendido.';
}
