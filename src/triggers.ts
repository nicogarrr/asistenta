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

export type TriggerEventType = 'archivo' | 'precio' | 'mensaje';
export const TRIGGER_EVENTS: readonly TriggerEventType[] = ['archivo', 'precio', 'mensaje'];

export interface TriggerEvent {
  type: TriggerEventType;
  /**
   * Chat scope the event belongs to (chat:telegram:<id>). Empty string means
   * a global event (file, price): it matches triggers from every chat.
   */
  scope: string;
  /** Haystack: message text, file name or price-alert text. */
  text: string;
}

/** Scope rule: a global event (scope '') matches every trigger; a chat event only its chat. */
export function triggerScopeMatches(triggerScope: string, eventScope: string): boolean {
  if (eventScope === '') return true;
  return triggerScope === eventScope || triggerScope.startsWith(`${eventScope}#`);
}

export function matchesTrigger(t: RoutineTrigger, e: TriggerEvent): boolean {
  if (!t.enabled || t.event !== e.type) return false;
  if (!triggerScopeMatches(t.scope, e.scope)) return false;
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
        await this.#run(built.prompt, { scope: t.scope, routine, trigger: t });
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
    '/disparador archivo .pdf | macro/archiva fichero=documentos, o /disparador mensaje factura | macro/archiva';
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
