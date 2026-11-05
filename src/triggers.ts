/**
 * Disparadores por evento de rutinas (token-cero): un evento del mundo real
 * (un archivo nuevo en Descargas, un aviso del vigilante de precios, un
 * mensaje que llega al chat) dispara una rutina ya guardada. La decisión de
 * disparar es código determinista - ningún LLM mira el evento ni decide -
 * y el prompt disparado sale por el MISMO camino que una rutina cron
 * (RoutineRunner.run): el reparto no cuesta tokens.
 *
 * Eventos:
 * - 'mensaje': texto que llega al chat. Ámbito: solo dispara triggers del
 *   chat donde llegó el mensaje.
 * - 'archivo': nombre de un archivo nuevo en la carpeta de Descargas
 *   vigilada (/ojo descargas on). Evento GLOBAL: dispara en cualquier chat
 *   que tenga el trigger y la rutina recibe el aviso en su propio chat.
 * - 'precio': texto de un aviso de precio. Global igual. Hoy no lo emite nadie: el
 *   vigilante de precios automático se quitó (31-oct-2026); se conserva para no romper
 *   disparadores ya guardados.
 * - 'correo': un correo nuevo en la bandeja de entrada (IMAP IDLE, solo lectura).
 *   Global igual. Casa por remitente y/o asunto, nunca por el cuerpo: «de:renfe»,
 *   «asunto:billete», las dos a la vez, o texto suelto que esté en cualquiera de las
 *   dos. La rutina recibe De y Asunto marcados como contenido de terceros.
 *
 * Seguridad heredada: el prompt disparado es el de la rutina guardada
 * (procedurePrompt o buildMacroPrompt con sus args fijos validados); las
 * reglas de la rutina (no teclear credenciales, parar en pagos, pedir
 * confirmación en lo destructivo) viajan con él. Un trigger nunca ejecuta
 * nada que la rutina no dijera ya.
 */
import { wallDateMinute } from './datecontext.js';
import type { Routine, RoutineTrigger, Store } from './db.js';
import { log } from './log.js';
import { buildMacroPrompt, isMacroName, procedurePrompt } from './routines.js';

export type TriggerEventType = 'archivo' | 'precio' | 'mensaje' | 'correo';
export const TRIGGER_EVENTS: readonly TriggerEventType[] = [
  'archivo',
  'precio',
  'mensaje',
  'correo',
];

export interface TriggerEvent {
  type: TriggerEventType;
  /**
   * Chat scope the event belongs to (chat:telegram:<id>). Empty string means
   * a global event (file, price): it matches triggers from every chat.
   */
  scope: string;
  /** Haystack: message text, file name or price-alert text. */
  text: string;
  /** 'correo': remitente y asunto, por separado (el cuerpo nunca entra). */
  mail?: { from: string; subject: string };
  /**
   * Nota que acompaña al prompt de la rutina (va DETRÁS, marcada por quien la
   * construye como contenido de terceros). Nunca sustituye al prompt guardado.
   */
  note?: string;
}

/** Lo que pide un disparador de correo: remitente, asunto y/o texto suelto. */
export interface MailMatch {
  from: string[];
  subject: string[];
  any: string[];
}

/**
 * «de:renfe asunto:"billete de tren" urgente» → remitente contiene «renfe», asunto
 * contiene «billete de tren» y «urgente» está en el remitente o en el asunto.
 * También valen from:/subject:. Determinista: nada de modelo.
 */
/** Palabras de enlace que no se buscan en el correo («correos de Renfe con billete»). */
const MAIL_STOPWORDS = new Set([
  'de',
  'del',
  'el',
  'la',
  'los',
  'las',
  'un',
  'una',
  'y',
  'e',
  'con',
  'en',
  'al',
  'a',
  'por',
  'para',
  'que',
]);

/** «o»/«u»/«or» entre dos palabras: cualquiera de las dos vale («de renfe o iberia»). */
const MAIL_OR = new Set(['o', 'u', 'or']);
/** Separador de alternativas dentro de un mismo valor («renfe|iberia»). */
const MAIL_ALT = '|';

export function parseMailMatch(match: string): MailMatch {
  const out: MailMatch = { from: [], subject: [], any: [] };
  // Comillas del móvil («“billete de tren”», ««billete de tren»») y «de: renfe» con espacio:
  // antes partían la frase en palabras sueltas o dejaban «de:» como texto que buscar, y el
  // disparador no saltaba nunca.
  const re = /(?:(de|from|asunto|subject):\s*)?(?:["“”«]([^"“”«»]*)["“”»]|(\S+))/gi;
  const parts = [...match.matchAll(re)].map((m) => ({
    key: (m[1] ?? '').toLowerCase(),
    quoted: m[2] !== undefined,
    comma: m[2] === undefined && /,$/.test(m[3] ?? ''),
    // «de renfe, asunto billete»: la coma pegada no es parte de lo que se busca.
    value: (m[2] ?? (m[3] ?? '').replace(/[,;.:!?)]+$/, '')).trim().toLocaleLowerCase('es'),
  }));
  type Part = (typeof parts)[number];
  const plain = (q: Part | undefined): q is Part => !!q && !q.key && !q.quoted && !!q.value;
  const isOr = (q: Part | undefined) => plain(q) && MAIL_OR.has(q.value);
  // «renfe, iberia o ouigo»: una lista con comas que acaba en «o» son alternativas.
  const listEndsInOr = (j: number): boolean => {
    while (plain(parts[j]) && parts[j]?.comma && !isOr(parts[j])) j++;
    return plain(parts[j]) && !isOr(parts[j]) && isOr(parts[j + 1]);
  };
  // Último valor guardado: a él se suman las alternativas que vienen tras «o».
  let last: { field: 'from' | 'subject' | 'any'; index: number } | null = null;
  let alternative = false;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as Part;
    if (!p.value) continue;
    // «de renfe o iberia»: antes «o» se buscaba como texto y renfe E iberia hacían falta a la
    // vez, así que el disparador no saltaba nunca. Ahora vale cualquiera de las dos.
    if (isOr(p)) {
      if (last && i + 1 < parts.length) alternative = true;
      continue;
    }
    let key = p.key;
    let value = p.value;
    // «de renfe», «del banco», «asunto billete» sin dos puntos: antes se buscaban «de» o
    // «del» como texto (un correo sin «del» no saltaba nunca) en vez del remitente.
    const next = parts[i + 1];
    if (!key && !p.quoted && next && !next.key && next.value && !MAIL_OR.has(next.value)) {
      // Solo al principio (o tras «o»: «de renfe o de iberia»): en medio («billete de tren»)
      // el «de» es parte de la frase.
      const as =
        (i === 0 || alternative) && (value === 'de' || value === 'del' || value === 'from')
          ? 'de'
          : value === 'asunto' || value === 'subject'
            ? 'asunto'
            : '';
      if (as) {
        key = as;
        value = next.value;
        i++;
      }
    }
    const field: 'from' | 'subject' | 'any' =
      key === 'de' || key === 'from'
        ? 'from'
        : key === 'asunto' || key === 'subject'
          ? 'subject'
          : 'any';
    if (alternative && last && (field === last.field || field === 'any')) {
      // La alternativa va al mismo sitio que la palabra anterior: «de renfe o iberia».
      const arr = out[last.field];
      arr[last.index] = `${arr[last.index]}${MAIL_ALT}${value}`;
      alternative = false;
      const cur = parts[i] as Part;
      if (cur.comma && listEndsInOr(i + 1)) alternative = true;
      continue;
    }
    alternative = false;
    if (field === 'any' && !p.quoted && MAIL_STOPWORDS.has(value)) continue;
    out[field].push(value);
    last = { field, index: out[field].length - 1 };
    const cur = parts[i] as Part;
    if (!cur.quoted && cur.comma && listEndsInOr(i + 1)) alternative = true;
  }
  return out;
}

/** «renfe|iberia» → cualquiera de las dos está en el texto. */
function hasAny(text: string, value: string): boolean {
  return value.split(MAIL_ALT).some((v) => v !== '' && text.includes(v));
}

export function mailMatches(match: string, mail: { from: string; subject: string }): boolean {
  const want = parseMailMatch(match);
  if (!want.from.length && !want.subject.length && !want.any.length) return false;
  const from = mail.from.toLocaleLowerCase('es');
  const subject = mail.subject.toLocaleLowerCase('es');
  return (
    want.from.every((v) => hasAny(from, v)) &&
    want.subject.every((v) => hasAny(subject, v)) &&
    want.any.every((v) => hasAny(from, v) || hasAny(subject, v))
  );
}

/** Scope rule: a global event (scope '') matches every trigger; a chat event only its chat. */
export function triggerScopeMatches(triggerScope: string, eventScope: string): boolean {
  if (eventScope === '') return true;
  return triggerScope === eventScope || triggerScope.startsWith(`${eventScope}#`);
}

export function matchesTrigger(t: RoutineTrigger, e: TriggerEvent): boolean {
  if (!t.enabled || t.event !== e.type) return false;
  if (!triggerScopeMatches(t.scope, e.scope)) return false;
  if (e.type === 'correo') return e.mail ? mailMatches(t.match, e.mail) : false;
  return e.text.toLocaleLowerCase('es').includes(t.match.toLocaleLowerCase('es'));
}

/**
 * The prompt a fire delivers. A macro gets its stored args validated and
 * substituted here (zero tokens); a schedule-kind routine delivers its own
 * prompt; a procedure delivers its replay sheet. Errors are returned, never
 * thrown: one rotten trigger must not take the dispatcher down.
 */
export function buildTriggerPrompt(
  routine: Routine,
  trigger: RoutineTrigger,
): { ok: true; prompt: string } | { ok: false; error: string } {
  if (isMacroName(routine.name)) {
    if (!routine.params?.length) {
      return {
        ok: false,
        error: `la macro ${routine.name} no tiene contrato de parámetros válido`,
      };
    }
    const built = buildMacroPrompt(routine, trigger.args ?? {});
    return built.ok ? built : { ok: false, error: built.error };
  }
  if (routine.kind === 'schedule' && routine.prompt) return { ok: true, prompt: routine.prompt };
  return { ok: true, prompt: procedurePrompt(routine) };
}

export interface TriggerFireContext {
  scope: string;
  routine: Routine;
  trigger: RoutineTrigger;
}

export interface TriggerEngineDeps {
  store: Store;
  /** Same signature as RoutineRunnerDeps.run: the cron delivery path, shared. */
  run: (prompt: string, ctx: TriggerFireContext) => Promise<void>;
  now?: () => number;
}

export interface EmitResult {
  matched: number;
  fired: number;
  skipped: number;
}

export class TriggerEngine {
  readonly #store: Store;
  readonly #run: (prompt: string, ctx: TriggerFireContext) => Promise<void>;
  readonly #now: () => number;

  constructor(deps: TriggerEngineDeps) {
    this.#store = deps.store;
    this.#run = deps.run;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * One event in, matching routines out. Never throws: a failing trigger is
   * logged and counted, the rest still fire.
   */
  async emit(event: TriggerEvent): Promise<EmitResult> {
    let matched = 0;
    let fired = 0;
    let skipped = 0;
    const nowMs = this.#now();
    for (const t of this.#store.listTriggers()) {
      if (!matchesTrigger(t, event)) continue;
      matched++;
      if (t.lastFiredAt && nowMs - Date.parse(t.lastFiredAt) < t.cooldownSeconds * 1000) {
        skipped++;
        continue;
      }
      const routine = this.#store.getRoutine(t.scope, t.routine);
      if (!routine || !routine.enabled) {
        skipped++;
        log.warn('trigger sin rutina viva', { trigger: t.id, routine: t.routine });
        continue;
      }
      const built = buildTriggerPrompt(routine, t);
      if (!built.ok) {
        skipped++;
        log.warn('trigger sin prompt válido', { trigger: t.id, error: built.error });
        continue;
      }
      // Marked BEFORE running: a crash mid-delivery must not storm the chat
      // with retries on the next event.
      this.#store.markTriggerFired(t.id, new Date(nowMs).toISOString());
      try {
        const prompt = event.note?.trim()
          ? `${built.prompt}\n\n${event.note.trim()}`
          : built.prompt;
        await this.#run(prompt, { scope: t.scope, routine, trigger: t });
        fired++;
      } catch (err) {
        skipped++;
        log.warn('trigger falló al disparar', {
          trigger: t.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { matched, fired, skipped };
  }
}

// ---- /disparador command parsing (pure, so canaries run without the daemon) ----

export interface ParsedTriggerAdd {
  event: TriggerEventType;
  match: string;
  routine: string;
  args: Record<string, string> | null;
}

/**
 * `/disparador <tipo> <coincidencia> | <rutina> [clave=valor...]`.
 * The '|' split mirrors /cron add: left is the needle, right the routine.
 */
export function parseTriggerAdd(
  rest: string,
): { ok: true; value: ParsedTriggerAdd } | { ok: false; error: string } {
  const USAGE =
    'Dime qué lo dispara y qué rutina hago, separados por una barra. Por ejemplo: ' +
    '«archivo .pdf | macro/archiva fichero=documentos», «mensaje factura | macro/archiva» ' +
    'o «correo de:renfe asunto:billete | guarda-billete».';
  const [left, ...rightParts] = rest.split('|');
  const right = rightParts.join('|').trim();
  const leftTrim = (left ?? '').trim();
  if (!right || !leftTrim) return { ok: false, error: USAGE };
  const [eventRaw, ...matchParts] = leftTrim.split(/\s+/);
  const event = (eventRaw ?? '').toLowerCase() as TriggerEventType;
  if (!TRIGGER_EVENTS.includes(event)) {
    return {
      ok: false,
      error: `Tipo desconocido "${eventRaw}". Valen: ${TRIGGER_EVENTS.join(', ')}.`,
    };
  }
  const match = matchParts.join(' ').trim();
  if (!match)
    return { ok: false, error: 'Falta la coincidencia (el texto que tiene que aparecer).' };
  const [routineRaw, ...argParts] = right.split(/\s+/).filter(Boolean);
  const routine = (routineRaw ?? '').trim();
  if (!routine) return { ok: false, error: 'Falta el nombre de la rutina.' };
  const args: Record<string, string> = {};
  for (const part of argParts) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      return { ok: false, error: `Argumento "${part}" sin clave=valor.` };
    }
    args[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return {
    ok: true,
    value: { event, match, routine, args: Object.keys(args).length ? args : null },
  };
}

/**
 * `lastFiredAt` is stored as an ISO instant (UTC). Nico reads the list on his own
 * clock, so it is shown in the process zone (PA_TIMEZONE, applied at start-up):
 * slicing the ISO string printed 22:30 for a fire at 23:30 in Madrid.
 */
/** Wall-clock minute in PA_TIMEZONE, not the process zone. */
function localMinute(iso: string): string {
  return wallDateMinute(new Date(iso));
}

/** One list line per trigger, numbered the way /disparador del expects. */
export function formatTriggerList(triggers: readonly RoutineTrigger[]): string {
  if (!triggers.length) {
    return 'No hay disparadores todavía.';
  }
  const lines = triggers.map((t, i) => {
    const off = t.enabled ? '' : ' (desactivado)';
    const when = t.lastFiredAt ? localMinute(t.lastFiredAt) : '';
    const last = when ? `, último: ${when}` : '';
    return `${i + 1}. [${t.event}] "${t.match}" → ${t.routine}${off} (cada ${t.cooldownSeconds}s mínimo${last})`;
  });
  return [`Disparadores: ${triggers.length}`, ...lines].join('\n');
}
