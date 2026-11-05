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
    const h = clamp(Number(hours) || LATIDO_DEFAULT_HOURS, 0.25, LATIDO_MAX_HOURS);
    const now = this.#now();
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
        `⏱️ Dejo de vigilar «${l.task}»: ya van ${hours} h. Si quieres que siga, dímelo.`,
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
    this.#timers.set(
      l.id,
      this.#later(() => void this.tick(l.id), ms),
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

/** «cada 10 min, durante 3 h»: cómo se le dice a Nico. */
export function latidoLine(l: Latido): string {
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
}): AgentTool<ReturnType<typeof Params>> {
  return {
    name: 'latido',
    label: 'Latido',
    description: [
      'Repeat a check in THIS chat every N minutes, with this conversation as context, and',
      'message the user ONLY when something changed; it stops by itself when what they wait',
      'for happened or after `hours`. Use it for «vigila esto cada 10 min», «mientras arreglo',
      'el router, mira cada 10 min si vuelve internet y avísame», «avísame cuando acabe la',
      'descarga». Not for a reminder at a time (reminder) nor a web page (/vigila).',
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
      const got = deps.latidos.start(
        scope,
        deps.chatIdOf(),
        String(args.task ?? ''),
        args.every_minutes,
        args.hours,
      );
      if (typeof got === 'string') return reply(got, true);
      return reply(
        `Vigilando ${latidoLine(got)}. Solo escribo si cambia algo, y paro solo al cumplirse. Primera comprobación en ${got.everyMin} min.`,
      );
    },
  };
}
