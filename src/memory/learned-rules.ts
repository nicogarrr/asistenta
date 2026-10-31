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
import { localDay } from '../datecontext.js';
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
  /(^|[\s,.!¡¿])(no,? asi no|no es asi|no era eso|te (he|lo he|habia) dicho|ya te (lo )?dije|te lo dije|no vuelvas a|nunca (me )?(hagas|pongas|digas|uses|respondas|mandes|escribas|contestes)|no (me )?(hagas|pongas|digas|uses|respondas|mandes|escribas|contestes) (mas|nunca)|te equivocas|no me gusta que|quiero que siempre|siempre que te|te has (equivocado|confundido|colado)|te confundes|no es eso\b|no hace falta que|no necesito que|no quiero que (me )?(respondas|contestes|hables|escribas|pongas|digas|mandes|uses|llames|trates)|mejor no (me )?(pongas|uses|digas|mandes|hagas|escribas|respondas|contestes)|(recuerda|acuerdate de) que (siempre|nunca|prefiero)|cada vez que te (pida|diga|pregunte|escriba)|hablame de tu\b|tuteame|no me (hables|trates) de usted)/;

/** Fin de frase: lo que sigue es nada o un signo (no «?»: «¿y eso no?» es una pregunta). */
const END = String.raw`(?=\s*(?:$|[,.!;:]))`;
/**
 * Frases que también son corrientes («eso no lo sé», «mi madre está mal», «no deja de
 * llover», «la próxima vez que vaya a Madrid»): solo cuentan en su forma de corrección.
 */
const LOOSE_CORRECTION = new RegExp(
  [
    String.raw`(^|[\s,.!¡¿])(eso|asi) no${END}`,
    String.raw`(^|[\s,.!¡¿])(eso|asi) no (es|era) (lo que|asi|correcto|cierto|verdad)\b`,
    String.raw`(^|[\s,.!¡¿])(eso|asi) no (lo|me) (quiero|queria|pedi|he pedido|gusta|sirve|vale)\b`,
    String.raw`(^|[\s,.!¡¿])(eso|esto|asi|todo eso) esta mal\b`,
    `^esta mal${END}`,
    String.raw`(^|[\s,.!¡¿])esta mal (hecho|dicho|escrito|calculado|traducido|resumido)\b`,
    String.raw`(^|[,.;!¡¿]\s*|\by |\bpor favor,? |\bporfa,? |\boye,? )deja de\b`,
    String.raw`(^|[\s,.!¡¿])(para )?la proxima vez(,| no | (hazlo|haz|pon|ponme|usa|di|dime|pregunta|preguntame|avisame|mandame|escribe|escribeme|responde|contesta|intenta|recuerda|acuerdate|quiero|prefiero|mejor)\b| que (me |te )?(pida|diga|pregunte|preguntes|escriba|escribas|hables|respondas|contestes|hagas|pongas|mandes|busques)\b|${END})`,
  ].join('|'),
);

/** Cosas de cómo responde («prefiero respuestas cortas», «a partir de ahora sin emojis»). */
const STYLE_NOUN = String.raw`(las |los |unas |unos )?(respuestas|mensajes|resumenes|explicaciones|textos|frases|listas|audios|notas|contestaciones|emojis|emoticonos)\b`;
/** Lo que el dueño le pide a Asistenta («que me respondas», «no uses»). */
const YOU_DO = String.raw`(no )?(me |te |lo |la |los |las |se |le |les )*(hagas|pongas|digas|uses|respondas|contestes|hables|escribas|mandes|envies|llames|trates|avises|preguntes|busques|repitas|tutees|seas|vayas|expliques|resumas|traduzcas|ensenes)\b`;
const ORDER = String.raw`(hazlo|haz|hazme|pon|ponme|ponlo|usa|di|dime|dimelo|responde|respondeme|contesta|contestame|habla|hablame|escribe|escribeme|avisa|avisame|manda|mandame|llama|llamame|trata|tratame|tuteame|recuerda|acuerdate|pregunta|preguntame|busca|buscame|evita|intenta)\b`;
/** Órdenes que no se confunden con la 3.ª persona («usa», «habla» sí: «mi hermano usa…»). */
const ORDER_ME = String.raw`(haz|hazlo|hazme|pon|ponme|ponlo|di|dime|dimelo|respondeme|contestame|hablame|escribeme|avisame|mandame|llamame|tratame|tuteame|preguntame|buscame|acuerdate)\b`;
const LANG = String.raw`(ingles|espanol|castellano|catalan|frances|aleman|italiano|portugues)\b`;
const FROM_NOW = '(a partir de ahora|desde ahora|de ahora en adelante)';
/**
 * «prefiero» y «a partir de ahora» también son corrientes («no sé qué prefiero», «desde
 * ahora hasta el viernes», «a partir de ahora estoy de vacaciones»): solo cuentan cuando
 * hablan de cómo debe responder o hacer las cosas Asistenta.
 */
const PREFER_OR_FROM_NOW = new RegExp(
  [
    String.raw`(^|[\s,.!¡¿])(prefiero|preferiria) que ${YOU_DO}`,
    String.raw`(^|[\s,.!¡¿])(prefiero|preferiria) (que (sean |me mandes |me pongas )?)?${STYLE_NOUN}`,
    String.raw`(^|[\s,.!¡¿])(prefiero|preferiria) (algo |las cosas )?(mas )?(cort[oa]s?|breves?|resumid[oa]s?|direct[oa]s?|detallad[oa]s?|concis[oa]s?)\b`,
    String.raw`(^|[\s,.!¡¿])(prefiero|preferiria) ((en |el )?${LANG}|el tuteo\b)`,
    String.raw`(^|[\s,.!¡¿])${FROM_NOW},? (${ORDER}|${YOU_DO}|(siempre|nunca|mejor) (${ORDER}|${YOU_DO})|(quiero|prefiero|preferiria) que|(sin|solo|con) ${STYLE_NOUN}|sin (rodeos|tecnicismos|formalidades)\b|en ${LANG}|${STYLE_NOUN})`,
    String.raw`(^|[\s,.!¡¿])(${ORDER_ME}|no ${YOU_DO})[^.!?]* ${FROM_NOW}${END}`,
  ].join('|'),
);

/** ¿Parece el mensaje del dueño una corrección o una preferencia duradera? */
export function looksLikeCorrection(text: string): boolean {
  const n = norm(text);
  return CORRECTION.test(n) || LOOSE_CORRECTION.test(n) || PREFER_OR_FROM_NOW.test(n);
}

export const LEARN_HINT =
  'Aprendizaje: el último mensaje del dueño parece corregirte. Si expresa una preferencia ' +
  'o regla duradera para el futuro, añade al final de tu respuesta UNA línea exacta ' +
  '`[[aprendido: <tema corto> | <regla breve en una frase>]]` (no la menciones). Si no es ' +
  'duradera, no la añadas. Nunca para permisos, aprobaciones ni seguridad.';

/**
 * Instrucción para el turno, o null si no toca (apagado, no es el dueño, no es corrección).
 * Enseña el dueño: su chat privado de Telegram (`ownerDm`) o el chat del panel local
 * (`panelOwner`: solo loopback y con token, en su hilo principal). Nada más.
 */
export function correctionHint(opts: {
  enabled: boolean;
  ownerDm: boolean;
  /** Turno del chat del panel local (loopback + token), en el hilo principal del dueño. */
  panelOwner?: boolean;
  ownerText: string;
}): string | null {
  if (!opts.enabled) return null;
  if (!opts.ownerDm && opts.panelOwner !== true) return null;
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

// Expresiones corrientes con una palabra de PRIVILEGED dentro, que no la tocan.
const HARMLESS =
  /\b(palabras?|puntos?|ideas?|datos?|frases?|conceptos?|fechas?|partes?) clave\b|\blista de (la )?compra\b/g;

/** true si la regla podría dar permisos o tocar seguridad (no se guarda). */
export function unsafeLearnedRule(rule: string): boolean {
  const n = norm(rule);
  const strict = n.match(STRICT) !== null;
  // «palabras clave» o «la lista de la compra» no hablan de claves ni de comprar.
  const rest = n.replace(STRICT, ' ').replace(HARMLESS, ' ');
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

/** Los números de la regla («10», «1,5»), sin orden ni repetidos. */
function numbers(text: string): string {
  return [...new Set(norm(text).match(/\d+(?:[.,]\d+)?/g) ?? [])].sort().join(' ');
}

// Palabras que no dicen de qué va la regla: «no», «nunca», «sin» le dan la vuelta y
// «siempre», «con» o un artículo no la cambian. Fuera de la comparación por raíces.
const FLIP_STOP = new Set(
  'no nunca jamas sin con siempre mas muy nada las los del que por para una uno unas unos'.split(
    ' ',
  ),
);

/** Raíz barata: «usa», «uses», «usar» → «us»; «emojis» → «emoji». */
function stem(w: string): string {
  const m = /^(.{2,}?)(amos|emos|imos|ando|iendo|ar|er|ir|as|es|an|en|os|a|e|o|s)$/.exec(w);
  return m?.[1] ?? w;
}

function stems(text: string): Set<string> {
  return new Set(
    norm(text)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !FLIP_STOP.has(w))
      .map(stem),
  );
}

/**
 * «Usa emojis» y «No uses emojis» hablan de lo mismo con el signo cambiado: words() las
 * veía distintas («usa» ≠ «uses») y se quedaban las dos, contradiciéndose. Si sus raíces
 * coinciden (sin contar «no», «nunca», «sin»…), es la misma regla y gana la nueva.
 */
function sameOrOpposite(a: string, b: string): boolean {
  const sa = stems(a);
  const sb = stems(b);
  if (!sa.size || !sb.size) return false;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter) >= 0.7;
}

function similar(a: string, b: string): boolean {
  // «Avisar 10 min antes» y «Avisar 30 min antes» son reglas distintas: words() no ve
  // los números, así que se comparan aparte. Con el mismo tema, la nueva sigue ganando.
  if (numbers(a) !== numbers(b)) return false;
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return norm(a) === norm(b);
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter) >= 0.7 || sameOrOpposite(a, b);
}

/** Reglas aprendidas activas del chat, de la más nueva a la más vieja. */
export function learnedRules(memory: MemoryStore, scopes: readonly string[]): MemoryEntry[] {
  // Con varios ámbitos, allIn los pone uno tras otro: dado la vuelta, las del último
  // ámbito salían primero aunque fueran viejas y el tope borraba las nuevas. Cada
  // ámbito de nuevo a viejo y luego por fecha; el mismo día, gana el primer ámbito.
  return [...new Set(scopes)]
    .flatMap((scope) =>
      memory
        .all(scope)
        .filter((e) => e.supersededBy === null && e.tags.includes(LEARNED_TAG))
        .reverse(),
    )
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
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
  /** Lo que lee /aprendido en este chat: una regla igual en otro de estos ámbitos también se sustituye. */
  readScopes: readonly string[] = [scope],
): LearnOutcome {
  const rule = rawRule.replace(/\s+/g, ' ').trim();
  if (!rule || rule.length > MAX_RULE_CHARS) return { status: 'invalid', rule };
  if (unsafeLearnedRule(rule) || (topic !== null && unsafeLearnedRule(topic))) {
    return { status: 'unsafe', rule };
  }
  const tTag = topicTag(topic);
  const tags = tTag ? [LEARNED_TAG, tTag] : [LEARNED_TAG];
  const looked = readScopes.includes(scope) ? readScopes : [scope, ...readScopes];
  const existing = learnedRules(memory, looked);
  const matches = existing.filter(
    (e) => (tTag !== null && e.tags.includes(tTag)) || similar(e.text, rule),
  );
  try {
    if (matches.length) {
      // Entra como nueva (fecha de hoy, primera en /aprendido) y sustituye a TODAS las que
      // decían lo mismo: corregir en su sitio la dejaba con la fecha vieja, el tope la
      // olvidaba antes que reglas más viejas y otra parecida se quedaba duplicada.
      const e = memory.remember(scope, rule, { tags });
      for (const m of matches) memory.forgetIn(looked, m.id);
      return { status: 'updated', rule, id: e.id };
    }
    const e = memory.remember(scope, rule, { tags });
    // Tope: la más vieja se olvida para que la memoria no crezca sin fin. Se cuenta en
    // todo lo que lee /aprendido: contado solo en este ámbito salían más de 30 y las
    // sobrantes no se podían ver ni borrar.
    const all = learnedRules(memory, looked);
    for (const old of all.slice(MAX_LEARNED_RULES)) memory.forgetIn(looked, old.id);
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
  /**
   * Ámbitos que lee /aprendido en este chat (Telegram). Si se dan, la línea dice con qué
   * número se borra («/olvida 2»); sin ellos (el panel, sin /olvida) no se dice.
   */
  forgetScopes?: readonly string[];
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
  const outcome = saveLearnedRule(opts.memory, opts.scope, rule, topic, opts.forgetScopes);
  if (outcome.status === 'saved' || outcome.status === 'updated') {
    const n = opts.forgetScopes
      ? learnedRules(opts.memory, opts.forgetScopes).findIndex((e) => e.id === outcome.id) + 1
      : 0;
    // Solo con un número que /olvida acepta (sale en /aprendido).
    const how = n >= 1 && n <= MAX_LEARNED_RULES ? ` (/olvida ${n} para borrarla)` : '';
    return { text, line: `📝 Aprendido: ${outcome.rule}${how}`, outcome };
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

/** «2026-10-31» → «31/10» (este año) o «31/10/2025» (otro año); lo raro, tal cual. */
export function shortDate(iso: string, today: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const dm = `${Number(m[3])}/${Number(m[2])}`;
  return m[1] === today.slice(0, 4) ? dm : `${dm}/${m[1]}`;
}

/** Texto de /aprendido. */
export function formatLearnedRules(
  rules: readonly MemoryEntry[],
  today: string = localDay(),
): string {
  if (!rules.length) {
    return 'Todavía no he aprendido ninguna regla. Cuando me corrijas («no, así no», «prefiero…»), la guardo sola.';
  }
  // Todas las que se guardan (el tope): antes salían 15 de 30 y las demás, que siguen
  // entrando en los turnos, no se veían ni se podían borrar. Telegram trocea si es largo.
  const shown = rules.slice(0, MAX_LEARNED_RULES);
  const lines = shown.map((r, i) => `${i + 1}. ${r.text} (${shortDate(r.date, today)})`);
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
  if (!/^\d+$/.test(arg.trim()) || n < 1 || n > Math.min(rules.length, MAX_LEARNED_RULES)) {
    return rules.length
      ? `Uso: /olvida <número> (de 1 a ${Math.min(rules.length, MAX_LEARNED_RULES)}, como salen en /aprendido)`
      : 'No hay reglas aprendidas que borrar.';
  }
  const target = rules[n - 1] as MemoryEntry;
  const ok = memory.forgetIn(scopes, target.id);
  return ok ? `🗑️ Olvidada: ${target.text}` : 'No he podido borrarla; mira /aprendido.';
}

/**
 * /aprendido y /olvida <n> escritos en el chat del panel local (en Telegram son comandos):
 * la respuesta, o null si el texto no es uno de ellos y va al modelo como siempre.
 * Borrar sigue siendo escrito: no hay botón de un toque.
 */
export function learnedRulesCommand(
  memory: MemoryStore,
  scopes: readonly string[],
  text: string,
): string | null {
  const m = /^\/(aprendido|aprendidas|olvida)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  if ((m[1] ?? '').toLowerCase() === 'olvida') return forgetLearnedRule(memory, scopes, m[2] ?? '');
  return formatLearnedRules(learnedRules(memory, scopes));
}
