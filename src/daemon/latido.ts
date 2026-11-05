/**
 * «Latido» del hilo: «mientras arreglo el router, cada 10 min mira si vuelve internet y
 * avísame». Repite una comprobación en ESTE chat, con el contexto de la conversación (corre
 * en el mismo hilo que las rutinas, routine-task.ts), y solo escribe cuando cambia algo. Se
 * para solo: cuando lo esperado ya pasó («HECHO:») o a las horas que se dijeron (3 por
 * defecto), y lo dice.
 *
 * Como /heartbeat de Hermes. Antes había rutinas cron (mínimo una hora entre avisos, sin
 * «solo si cambia» ni final), /vigila de páginas y objetivos, pero nada que repitiera una
 * pregunta dentro del mismo hilo.
 *
 * Se guarda en disco: un reinicio (auto-actualización) no lo pierde.
 */
import { readFileSync } from 'node:fs';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { lazySchema, Type } from '../core/lazy-schema.js';
import { writeFileReplacing } from '../fs-tmp.js';
import { log } from '../log.js';
import { foldAccents } from '../text.js';
import { whenFromWords } from '../tools/reminder.js';

export const LATIDO_MIN_EVERY = 5;
export const LATIDO_MAX_EVERY = 120;
export const LATIDO_DEFAULT_EVERY = 10;
export const LATIDO_DEFAULT_HOURS = 3;
export const LATIDO_MAX_HOURS = 12;
export const LATIDO_MAX_PER_CHAT = 3;
/** Si el hilo está ocupado (Nico hablando), la comprobación espera esto y vuelve a mirar. */
export const LATIDO_BUSY_RETRY_MS = 60_000;

/** Lo que contesta el modelo cuando no hay nada nuevo: no se manda nada. */
export const LATIDO_QUIET = 'SIN_CAMBIOS';
/** Lo que contesta cuando ya pasó lo esperado: se avisa y se para. */
export const LATIDO_DONE = 'HECHO:';

export interface Latido {
  id: string;
  scope: string;
  chatId: string;
  task: string;
  everyMin: number;
  startedAt: number;
  untilMs: number;
  checks: number;
  /** Lo último que se le dijo a Nico (para no repetirlo). */
  last?: string;
  /** La hora de fin tal como se le dice («las 20:00»), si la dijo él («hasta las 8»). */
  hasta?: string;
}

export interface LatidoDeps {
  /** Corre la comprobación en el hilo del chat (createRoutineTask) y devuelve el texto. */
  run: (prompt: string, scope: string, latido: Latido) => Promise<string>;
  send: (chatId: string, text: string) => Promise<unknown>;
  /** ¿El hilo está atendiendo a Nico ahora? Entonces la comprobación espera un poco. */
  isBusy?: (scope: string) => boolean;
  now?: () => number;
  /** Fichero donde se guardan (sin él, solo en memoria). */
  file?: string;
  later?: (fn: () => void, ms: number) => { cancel: () => void };
}

const defaultLater = (fn: () => void, ms: number): { cancel: () => void } => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** El texto que se le pasa al modelo en cada comprobación. */
export function latidoPrompt(l: Latido): string {
  const left = Math.max(0, Math.round((l.untilMs - l.startedAt) / 3_600_000));
  return [
    `[Latido: comprobación automática nº ${l.checks + 1} que el dueño pidió en este chat cada ${l.everyMin} min, durante ${left || 1} h]`,
    `Qué vigilar: ${l.task}`,
    'Compruébalo ahora con tus herramientas, sin preguntar nada. Contesta SOLO una de estas:',
    `- «${LATIDO_QUIET}» si no ha cambiado nada desde la comprobación anterior o no hay nada que contarle;`,
    `- «${LATIDO_DONE} <una línea>» si ya pasó lo que esperaba (entonces dejo de vigilar);`,
    '- una o dos líneas con lo que ha cambiado.',
    `Lo último que le dijiste: ${l.last ?? 'nada todavía'}`,
  ].join('\n');
}

const same = (a: string, b: string): boolean =>
  foldAccents(a).replace(/\W+/g, ' ').trim() === foldAccents(b).replace(/\W+/g, ' ').trim();

export class Latidos {
  readonly #deps: LatidoDeps;
  readonly #items = new Map<string, Latido>();
  readonly #timers = new Map<string, { cancel: () => void }>();
  readonly #later: NonNullable<LatidoDeps['later']>;
  readonly #now: () => number;
  #seq = 0;

  constructor(deps: LatidoDeps) {
    this.#deps = deps;
    this.#later = deps.later ?? defaultLater;
    this.#now = deps.now ?? Date.now;
  }

  /** Vuelve a programar los que había en disco (tras un reinicio). */
  restore(): number {
    if (!this.#deps.file) return 0;
    let saved: Latido[] = [];
    try {
      saved = JSON.parse(readFileSync(this.#deps.file, 'utf8')) as Latido[];
    } catch {
      return 0;
    }
    if (!Array.isArray(saved)) return 0;
    for (const l of saved) {
      if (!l || typeof l.id !== 'string' || typeof l.task !== 'string') continue;
      if (l.untilMs <= this.#now()) continue;
      this.#items.set(l.id, l);
      this.#schedule(l, l.everyMin * 60_000);
    }
    this.#save();
    return this.#items.size;
  }

  list(scope: string): Latido[] {
    return [...this.#items.values()].filter((l) => l.scope === scope);
  }

  start(
    scope: string,
    chatId: string,
    task: string,
    everyMin = LATIDO_DEFAULT_EVERY,
    hours = LATIDO_DEFAULT_HOURS,
    end: { untilMs?: number; hasta?: string } = {},
  ): Latido | string {
    const what = task.replace(/\s+/g, ' ').trim();
    if (!what) return 'Falta qué vigilar.';
    if (what.length > 300) return 'Dímelo más corto (300 caracteres como mucho).';
    if (!chatId) return 'Solo funciona en un chat de Telegram.';
    const mine = this.list(scope);
    const dup = mine.find((l) => same(l.task, what));
    if (dup) this.#drop(dup.id);
    else if (mine.length >= LATIDO_MAX_PER_CHAT)
      return `Ya vigilo ${mine.length} cosas en este chat: para alguna antes.`;
    const every = clamp(
      Math.round(Number(everyMin) || LATIDO_DEFAULT_EVERY),
      LATIDO_MIN_EVERY,
      LATIDO_MAX_EVERY,
    );
    const now = this.#now();
    let h = clamp(Number(hours) || LATIDO_DEFAULT_HOURS, 0.25, LATIDO_MAX_HOURS);
    if (end.untilMs !== undefined) {
      const left = end.untilMs - now;
      const said = end.hasta ? `hasta ${end.hasta}` : 'Esa hora';
      if (left > LATIDO_MAX_HOURS * 3_600_000)
        return `${said} son más de ${LATIDO_MAX_HOURS} h: como mucho vigilo ${LATIDO_MAX_HOURS} h seguidas.`;
      if (left < every * 60_000)
        return `${said} no da tiempo a ninguna comprobación (una cada ${every} min).`;
      h = left / 3_600_000;
    }
    this.#seq++;
    const l: Latido = {
      id: `${now.toString(36)}${this.#seq}`,
      scope,
      chatId,
      task: what,
      everyMin: every,
      startedAt: now,
      untilMs: now + Math.round(h * 3_600_000),
      checks: 0,
      ...(end.untilMs !== undefined && end.hasta ? { hasta: end.hasta } : {}),
    };
    this.#items.set(l.id, l);
    this.#schedule(l, every * 60_000);
    this.#save();
    return l;
  }

  /** Para los de este chat que casan con `needle` (todos si no se dice). */
  stop(scope: string, needle = ''): Latido[] {
    const want = foldAccents(needle).trim();
    const hit = this.list(scope).filter((l) => !want || foldAccents(l.task).includes(want));
    for (const l of hit) this.#drop(l.id);
    if (hit.length) this.#save();
    return hit;
  }

  /** Los de todos los hilos de un chat (`chatKey` y `chatKey#hilo`). */
  listInChat(chatKey: string): Latido[] {
    return [...this.#items.values()].filter(
      (l) => l.scope === chatKey || l.scope.startsWith(`${chatKey}#`),
    );
  }

  /** Igual que `stop`, pero en todos los hilos de un chat (`chatKey` y `chatKey#hilo`). */
  stopInChat(chatKey: string, needle = ''): Latido[] {
    const scopes = new Set(
      [...this.#items.values()]
        .map((l) => l.scope)
        .filter((s) => s === chatKey || s.startsWith(`${chatKey}#`)),
    );
    return [...scopes].flatMap((s) => this.stop(s, needle));
  }

  /** Una comprobación (la llama el temporizador; pública para las pruebas). */
  async tick(id: string): Promise<void> {
    const l = this.#items.get(id);
    if (!l) return;
    if (this.#now() >= l.untilMs) {
      this.#drop(id);
      this.#save();
      const hours = Math.max(1, Math.round((l.untilMs - l.startedAt) / 3_600_000));
      await this.#say(
        l,
        l.hasta
          ? `⏱️ Dejo de vigilar «${l.task}»: ya son ${l.hasta}, como dijiste. Si quieres que siga, dímelo.`
          : `⏱️ Dejo de vigilar «${l.task}»: ya van ${hours} h. Si quieres que siga, dímelo.`,
      );
      return;
    }
    if (this.#deps.isBusy?.(l.scope)) {
      this.#schedule(l, LATIDO_BUSY_RETRY_MS);
      return;
    }
    let text = '';
    try {
      text = (await this.#deps.run(latidoPrompt(l), l.scope, l)).trim();
    } catch (err) {
      // Sin red o el modelo caído: se salta esta, la siguiente vuelve a mirar.
      log.warn('latido check failed', { err: String(err) });
    }
    if (!this.#items.has(id)) return; // lo pararon mientras comprobaba
    l.checks++;
    if (text.startsWith(LATIDO_DONE)) {
      this.#drop(id);
      this.#save();
      const said = text.slice(LATIDO_DONE.length).trim();
      await this.#say(l, `✅ ${said || 'Ya está.'}\n(Dejo de vigilar «${l.task}».)`);
      return;
    }
    const news = text && !text.includes(LATIDO_QUIET) && !(l.last && same(l.last, text));
    if (news) {
      l.last = text.slice(0, 500);
      await this.#say(l, `👀 ${text}`);
    }
    this.#save();
    this.#schedule(l, l.everyMin * 60_000);
  }

  stopAll(): void {
    for (const t of this.#timers.values()) t.cancel();
    this.#timers.clear();
  }

  async #say(l: Latido, text: string): Promise<void> {
    try {
      await this.#deps.send(l.chatId, text);
    } catch (err) {
      log.warn('latido send failed', { err: String(err) });
    }
  }

  #schedule(l: Latido, ms: number): void {
    this.#timers.get(l.id)?.cancel();
    // Con hora de fin dicha («hasta las 8»), el último toque es a esa hora y no hasta 10 min tarde.
    const wait = l.hasta ? Math.max(0, Math.min(ms, l.untilMs - this.#now())) : ms;
    this.#timers.set(
      l.id,
      this.#later(() => void this.tick(l.id), wait),
    );
  }

  #drop(id: string): void {
    this.#timers.get(id)?.cancel();
    this.#timers.delete(id);
    this.#items.delete(id);
  }

  #save(): void {
    if (!this.#deps.file) return;
    try {
      writeFileReplacing(this.#deps.file, JSON.stringify([...this.#items.values()], null, 1));
    } catch (err) {
      log.warn('latido save failed', { err: String(err) });
    }
  }
}

/**
 * «Deja de vigilar», «para de vigilar lo de la web», «ya no hace falta que vigiles»: parar sin
 * pasar por el modelo. Devuelve la palabra a buscar ('' = todos los del chat) o null si no
 * es eso.
 */
export function latidoStopRequest(text: string): string | null {
  const t = foldAccents(text.toLowerCase())
    .replace(/\s+/g, ' ')
    .replace(/[.!¡]+$/u, '')
    .trim();
  const m =
    /^(?:ya\s+)?(?:(?:para|deja|dejar)\s+de\s+vigilar(?:lo|la|los)?|no\s+vigiles(?:\s+mas)?|ya no hace falta que vigiles|(?:para|quita|borra|cancela|elimina)\s+(?:el|los)\s+latidos?|(?:para|quita|borra|cancela|elimina|deten)\s+(?:la|las|mis)\s+vigilancias?(?:\s+de)?)(?:\s+(?:lo de\s+|eso de\s+|el\s+|la\s+|los\s+|las\s+)?(.{2,60}))?$/.exec(
      t,
    );
  if (!m) return null;
  const rest = (m[1] ?? '').replace(/^(?:ya|eso|nada|mas)$/, '').trim();
  return rest;
}

/** «¿Qué estás vigilando?», «¿qué vigilas?»: la lista al momento, sin modelo. */
export function latidoListRequest(text: string): boolean {
  const t = foldAccents(text.toLowerCase())
    .replace(/[¿?¡!.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(?:y\s+)?(?:que|que cosas|que mas)\s+(?:estas|sigues|me estas)\s+vigilando(?: ahora)?$|^(?:y\s+)?que vigilas(?: ahora)?$|^(?:estas|sigues) vigilando algo$|^(?:que|cuales)\s+vigilancias\s+(?:tengo|hay)(?: puestas| activas)?$|^(?:mis|ver|ensename)\s+(?:las\s+|mis\s+)?vigilancias$/.test(
    t,
  );
}

/**
 * La hora de fin dicha: «hasta las 8» (a las 10 de la mañana son las 20:00), «hasta las 8 de
 * la tarde», «hasta mediodía», «hasta medianoche», «hasta las 20:30». Antes solo valía un
 * número de horas que tenía que calcular el modelo, y «hasta las 8» acababa en 3 h (lo de
 * por defecto) o en una cuenta mal hecha. null si no es una hora.
 */
export function latidoHasta(said: string, now: Date, timeZone?: string): Date | null {
  let t = said
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/u, '')
    .replace(/^hasta\s+(?:que\s+sean\s+)?/iu, '');
  if (!t) return null;
  if (/^\d{1,2}(?:[:,.]\d{2})?(?:\s*h)?$/u.test(t))
    t = `las ${t.replace(/\s*h$/u, '').replace(/[,.]/u, ':')}`;
  if (/^(?:las?\s|mediod[ií]a$|medianoche$)/iu.test(t)) t = `a ${t}`;
  // «hasta mañana a las 9»: vigilar de noche hasta por la mañana (antes se volvía a preguntar).
  const otroDia = /^(?:ma[nñ]ana|pasado\s+ma[nñ]ana)\s+(?:a\s+)?(?:las?\s|mediod[ií]a$)/iu.test(t);
  if (otroDia) t = t.replace(/^((?:pasado\s+)?ma[nñ]ana)\s+(?!a\s)/iu, '$1 a ');
  if (!otroDia && !/^a\s/iu.test(t)) return null;
  const at = whenFromWords(t, now, timeZone);
  return at && at.getTime() > now.getTime() ? at : null;
}

/** «las 20:00», «la 1:00»: una hora como se le dice a Nico. */
export function horaDicha(d: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('es-ES', {
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return `${h === 1 ? 'la' : 'las'} ${h}:${m}`;
}

/** «cada 10 min, durante 3 h»: cómo se le dice a Nico. */
export function latidoLine(l: Latido): string {
  if (l.hasta) return `«${l.task}» cada ${l.everyMin} min, hasta ${l.hasta}`;
  const hours = Math.round(((l.untilMs - l.startedAt) / 3_600_000) * 10) / 10;
  return `«${l.task}» cada ${l.everyMin} min, durante ${String(hours).replace('.', ',')} h`;
}

const Params = lazySchema(() =>
  Type.Object({
    action: Type.Union([Type.Literal('start'), Type.Literal('stop'), Type.Literal('list')]),
    task: Type.Optional(
      Type.String({
        description:
          'start: what to check each time and what the user is waiting for, with the context needed («si ya vuelve internet: haz ping a 8.8.8.8»). stop: a word from it (empty = all).',
      }),
    ),
    every_minutes: Type.Optional(
      Type.Number({
        description: `start: minutes between checks (${LATIDO_MIN_EVERY}–${LATIDO_MAX_EVERY}, default ${LATIDO_DEFAULT_EVERY}).`,
      }),
    ),
    hours: Type.Optional(
      Type.Number({
        description: `start: stop after this many hours (default ${LATIDO_DEFAULT_HOURS}, max ${LATIDO_MAX_HOURS}).`,
      }),
    ),
    until: Type.Optional(
      Type.String({
        description:
          'start: the end time exactly as the user said it («hasta las 8», «hasta las 20:30», «hasta mediodía», «hasta medianoche»). Use it instead of hours when they said a time; do not convert it yourself.',
      }),
    ),
  }),
);

function reply(text: string, isError = false): AgentToolResult<Record<string, never>> {
  return { content: [{ type: 'text', text }], details: {}, isError };
}

/** La herramienta `latido` del hilo. El chat lo pone quien llama, nunca el modelo. */
export function createLatidoTool(deps: {
  latidos: Latidos;
  scopeOf: () => string;
  chatIdOf: () => string;
  now?: () => number;
  timeZone?: string;
}): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'latido',
    label: 'Latido',
    description: [
      'Repeat a check in THIS chat every N minutes, with this conversation as context, and',
      'message the user ONLY when something changed; it stops by itself when what they wait',
      'for happened or after `hours`. Use it for «vigila esto cada 10 min», «mientras arreglo',
      'el router, mira cada 10 min si vuelve internet y avísame», «avísame cuando acabe la',
      'descarga», «vigila la web cada 10 min hasta las 8» (until). Not for a reminder at a',
      'time (reminder) nor a web page (/vigila).',
      'action=list shows them; action=stop with a word from the task stops it.',
    ].join('\n'),
    parameters: Params(),
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const scope = deps.scopeOf();
      if (args.action === 'list') {
        const mine = deps.latidos.list(scope);
        return reply(
          mine.length
            ? `Vigilando:\n${mine.map((l) => `- ${latidoLine(l)}`).join('\n')}`
            : 'No estoy vigilando nada en este chat.',
        );
      }
      if (args.action === 'stop') {
        const gone = deps.latidos.stop(scope, String(args.task ?? ''));
        return reply(
          gone.length
            ? `Dejo de vigilar: ${gone.map((l) => `«${l.task}»`).join(', ')}.`
            : 'No había nada así vigilándose en este chat.',
        );
      }
      const until = String(args.until ?? '').trim();
      let end: { untilMs?: number; hasta?: string } = {};
      if (until) {
        const at = latidoHasta(until, new Date((deps.now ?? Date.now)()), deps.timeZone);
        if (!at)
          return reply(
            `No entiendo «${until}» como hora de fin: dímelo como «hasta las 20:00» o «durante 2 horas».`,
            true,
          );
        end = { untilMs: at.getTime(), hasta: horaDicha(at, deps.timeZone) };
      }
      const got = deps.latidos.start(
        scope,
        deps.chatIdOf(),
        String(args.task ?? ''),
        args.every_minutes,
        args.hours,
        end,
      );
      if (typeof got === 'string') return reply(got, true);
      return reply(
        `Vigilando ${latidoLine(got)}. Solo escribo si cambia algo, y paro solo al cumplirse${got.hasta ? ` o a ${got.hasta}` : ''}. Primera comprobación en ${got.everyMin} min.`,
      );
    },
  };
}
