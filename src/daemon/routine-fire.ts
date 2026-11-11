import { isCommandRoutine } from '../command-routine.js';
import { isOutageError } from '../core/friendly-error.js';
import type { Store } from '../db.js';
import { isGoalRoutine } from '../goals/runner.js';
import { log } from '../log.js';
import {
  type DeliveryPlan,
  planDelivery,
  type RoutineDeliveryStore,
  writeRoutineOutput,
} from '../routine-delivery.js';
import type { RoutineRun } from '../routine-history.js';
import { procedurePrompt, type RoutineRunContext } from '../routines.js';
import {
  deliverMissedReminders,
  isOneShotReminder,
  isReminder,
  oneShotStillPending,
  parkFailedRepeating,
  recordDroppedReminder,
  reminderEnded,
  reminderText,
  settleOneShot,
} from '../tools/reminder.js';
import { AUTO_RETRY_DELAYS_MS, retryDelayText } from './auto-retry.js';
import { type PendingResend, RESEND_MAX_AGE_MS } from './routine-resend-queue.js';
import { RoutineStoppedError } from './rutina-parar.js';

/**
 * La tarea de una rutina no pudo hablar con el modelo (sin red o servicio caído).
 * createRoutineTask la lanza para que el disparo la reintente más tarde en vez de
 * mandar «No devolvió respuesta» y perder el informe de esa mañana.
 */
export class RoutineOutageError extends Error {
  readonly raw: string;
  constructor(raw: string) {
    super(raw);
    this.raw = raw;
    this.name = 'RoutineOutageError';
  }
}

/**
 * Chat de Telegram de un scope `telegram:dm:<chatId>#<hilo>` ('' si no tiene).
 * Es la regla que usa el daemon para saber a qué chat contesta una rutina.
 */
export function chatIdOfScope(scope: string): string {
  const [chatPart] = scope.split('#');
  return chatPart?.split(':')[2] ?? '';
}

export interface RoutineFireDeps {
  store: Store;
  /** Un tick de objetivo EJECUTA el objetivo; nunca entrega su prompt como mensaje. */
  tickGoal: (routineName: string) => Promise<unknown>;
  /** Ejecuta el trabajo real de una rutina (no recordatorio) y devuelve su texto. */
  runTask: (task: string, ctx: RoutineRunContext) => Promise<string>;
  /** Envía un mensaje al chat. Rechaza si el envío falla. */
  send: (
    chatId: string,
    text: string,
    buttons?: Array<{ label: string; action: string }>,
  ) => Promise<unknown>;
  /**
   * Botones del aviso de un recordatorio («✅ Hecho» / «⏰ +1h»), o undefined para
   * mandarlo sin botones. Recibe el ámbito y el texto del recordatorio.
   */
  reminderButtons?: (
    scope: string,
    text: string,
  ) => Array<{ label: string; action: string }> | undefined;
  /** Re-sincroniza el planificador (tras borrar o reprogramar un recordatorio puntual). */
  sync: () => void;
  /** F6: adónde va la salida de cada rutina (chat/fichero/nada) y «solo si cambia». */
  delivery: Pick<RoutineDeliveryStore, 'get' | 'commit'>;
  /** Carpeta de las salidas a fichero (F6). */
  outputDir: string;
  /** Fichero jsonl donde se apuntan los recordatorios puntuales abandonados. */
  droppedRemindersPath: string;
  /**
   * F4: ejecuta una rutina de comando (sin modelo). Ausente = función apagada:
   * la rutina avisa y no hace nada; jamás cae a runTask.
   */
  fireCommand?: (ctx: RoutineRunContext) => Promise<{ body: string; failed: boolean }>;
  /**
   * Sin red o con el modelo caído, la rutina se reintenta tras estas esperas
   * (por defecto 1, 2, 5, 10 y 15 min). Lista vacía = no reintentar (PA_AUTO_RETRY=0).
   */
  outageDelaysMs?: readonly number[];
  /** Programa un reintento (por defecto setTimeout sin retener el proceso). Para pruebas. */
  later?: (fn: () => void, ms: number) => { cancel: () => void };
  /**
   * Cola en disco de informes que Telegram no aceptó (RoutineResendQueue): sobrevive
   * a un reinicio y `resumePending()` los reenvía al arrancar. Ausente = solo memoria.
   */
  resendQueue?: {
    all: () => PendingResend[];
    put: (entry: PendingResend) => void;
    remove: (scope: string, routine: string) => void;
  };
  /** Historial de ejecuciones por rutina (RoutineHistory); ausente = no se apunta. */
  history?: {
    record: (scope: string, name: string, run: RoutineRun) => void;
    markResent: (scope: string, name: string) => void;
  };
  /**
   * Terminó una rutina (con su salida) o sonó un recordatorio: lo usan los scripts del
   * usuario en eventos (scripts-eventos.ts). Nunca bloquea ni tumba el disparo.
   */
  onDone?: (done: RoutineDone) => void;
}

export interface RoutineDone {
  scope: string;
  name: string;
  reminder: boolean;
  /** Recordatorio: su texto; rutina: su nombre. */
  text: string;
  ok: boolean;
  salida: string;
}

/** Lo que devuelve createRoutineFire: el disparo, más el reenvío de lo pendiente al arrancar. */
export type RoutineFire = ((prompt: string, ctx: RoutineRunContext) => Promise<void>) & {
  /** Reprograma los informes pendientes que dejó el arranque anterior; devuelve cuántos. */
  resumePending: () => number;
};

/** Espera mínima tras arrancar antes de reenviar lo pendiente. */
export const RESUME_MIN_WAIT_MS = 30_000;

const defaultLater = (fn: () => void, ms: number): { cancel: () => void } => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
};

/**
 * Lo que hace el daemon cuando se dispara una rutina (cron, catch-up o
 * disparador por evento): tick de objetivo, recordatorio o rutina que trabaja.
 * Extraído de serveCommand (src/cli.ts) sin cambiar el comportamiento.
 */
export function createRoutineFire(deps: RoutineFireDeps): RoutineFire {
  const { store } = deps;
  const delays = deps.outageDelaysMs ?? AUTO_RETRY_DELAYS_MS;
  const later = deps.later ?? defaultLater;
  /** Reintento pendiente por rutina: un disparo nuevo a su hora lo sustituye. */
  const pendingRetry = new Map<string, { cancel: () => void }>();
  /** El historial nunca tumba una rutina. */
  const note = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      log.warn('routine history failed', { err });
    }
  };
  // La salida ya está hecha pero Telegram no la aceptó (sin red un rato, tras sus
  // reintentos de 90 s): antes se perdía (el informe de las 8:00 no llegaba). Se
  // reenvía la misma salida más tarde, sin volver a trabajar; un disparo nuevo a su
  // hora la sustituye. Con cola en disco, también sobrevive a un reinicio.
  const scheduleResend = (entry: PendingResend, waitMs?: number): void => {
    const key = `${entry.scope}\u0000${entry.routine}`;
    const delay = delays[entry.attempt];
    if (delay === undefined) {
      log.warn('routine output dropped after failed resends', { routine: entry.routine });
      deps.resendQueue?.remove(entry.scope, entry.routine);
      return;
    }
    deps.resendQueue?.put(entry);
    const wait = waitMs ?? delay;
    const handle = later(() => {
      pendingRetry.delete(key);
      const lateText = `⏰ ${entry.routine}${sendLateNote(Date.now() - entry.firstAt)}\n\n${entry.body}`;
      void deps
        .send(entry.chatId, lateText)
        .then(() => {
          deps.resendQueue?.remove(entry.scope, entry.routine);
          deps.delivery.commit(entry.scope, entry.routine, entry.hash);
          note(() => deps.history?.markResent(entry.scope, entry.routine));
          log.info('routine output resent', { routine: entry.routine, attempt: entry.attempt + 1 });
        })
        .catch((err: unknown) => {
          log.warn('routine resend failed', { routine: entry.routine, err });
          const next = entry.attempt + 1;
          scheduleResend({ ...entry, attempt: next, dueAt: Date.now() + (delays[next] ?? 0) });
        });
    }, wait);
    pendingRetry.set(key, handle);
  };
  /** Al arrancar: lo que quedó pendiente de reenviar antes del reinicio. */
  const resumePending = (): number => {
    const queue = deps.resendQueue;
    if (!queue) return 0;
    let n = 0;
    for (const entry of queue.all()) {
      if (Date.now() - entry.firstAt > RESEND_MAX_AGE_MS) {
        log.warn('stale routine output dropped at startup', { routine: entry.routine });
        queue.remove(entry.scope, entry.routine);
        continue;
      }
      if (pendingRetry.has(`${entry.scope}\u0000${entry.routine}`)) continue;
      // Lo que ya tocaba sale a los 30 s del arranque (Telegram listo), no antes.
      scheduleResend(entry, Math.max(RESUME_MIN_WAIT_MS, entry.dueAt - Date.now()));
      n++;
    }
    if (n) log.info('routine outputs pending resend after restart', { count: n });
    return n;
  };
  const fire = async (
    _prompt: string,
    ctx: RoutineRunContext,
    attempt = 0,
    firstAt = Date.now(),
  ): Promise<void> => {
    const retryKey = `${ctx.scope}\u0000${ctx.routine.name}`;
    if (attempt === 0) {
      pendingRetry.get(retryKey)?.cancel();
      pendingRetry.delete(retryKey);
      // Un disparo nuevo a su hora sustituye al informe viejo pendiente de reenvío.
      if (!isGoalRoutine(ctx.routine) && !isReminder(ctx.routine)) {
        deps.resendQueue?.remove(ctx.scope, ctx.routine.name);
      }
    }
    // A goal tick EXECUTES; it never delivers its prompt as a message.
    if (isGoalRoutine(ctx.routine)) {
      await deps.tickGoal(ctx.routine.name);
      return;
    }
    // A scheduled routine answers into the chat it was learned in. It reuses the
    // thread of that scope when one exists, so the conversation that created the
    // routine also receives its output.
    const chatId = chatIdOfScope(ctx.scope);
    if (!chatId) return;
    // A one-time reminder deleted after this job was registered (delivered late at
    // startup, cancelled) must not send again from a stale callback.
    if (isOneShotReminder(ctx.routine) && !oneShotStillPending(store, ctx.routine)) return;
    // A repeating reminder whose last day («hasta …») has passed stops for good.
    if (isReminder(ctx.routine) && reminderEnded(ctx.routine)) {
      store.deleteRoutine(ctx.scope, ctx.routine.name);
      deps.sync();
      return;
    }
    log.info('routine fired', { routine: ctx.routine.name, chatId });
    const reminder = isReminder(ctx.routine);
    // Un recordatorio solo avisa; una rutina TRABAJA. La tarea real se saca del
    // prompt de la rutina (o de su procedimiento guardado) y se ejecuta aquí,
    // como haría /routine a mano. `prompt` (los metadatos que pasa el runner) no
    // se usa para trabajar.
    const task = reminder
      ? ''
      : ctx.routine.kind === 'schedule' && ctx.routine.prompt
        ? ctx.routine.prompt
        : procedurePrompt(ctx.routine);
    let body = '';
    let plan: DeliveryPlan | null = null;
    const startedAt = Date.now();
    let failed = false;
    const record = (entrega: RoutineRun['entrega'], salida = body): void =>
      note(() =>
        deps.history?.record(ctx.scope, ctx.routine.name, {
          at: startedAt,
          ok: !failed,
          ms: Date.now() - startedAt,
          entrega,
          salida,
        }),
      );
    if (!reminder) {
      if (isCommandRoutine(ctx.routine)) {
        // F4: un comando aprobado, sin modelo. Nunca se manda a runTask.
        const out = deps.fireCommand
          ? await deps.fireCommand(ctx).catch((err: unknown) => {
              log.warn('command routine failed', { routine: ctx.routine.name, err });
              return {
                body: `No se pudo ejecutar el comando: ${commandFailure(err)}.`,
                failed: true,
              };
            })
          : {
              body: 'Las rutinas de comando están desactivadas (PA_CRON_COMANDOS=1 para activarlas). No se ha ejecutado nada.',
              failed: true,
            };
        body = out.body;
        failed = out.failed;
      } else {
        try {
          body = await deps.runTask(task, ctx);
        } catch (err) {
          // «/cron parar»: el dueño ya tiene su confirmación; no se manda nada más.
          if (err instanceof RoutineStoppedError) {
            log.info('routine stopped by the owner', { routine: ctx.routine.name });
            record('parada', 'Parada por ti con /cron parar.');
            return;
          }
          failed = true;
          log.warn('routine execution failed', { routine: ctx.routine.name, err });
          // Sin red o con el modelo caído: se reintenta más tarde y llega con retraso,
          // en vez de un «No devolvió respuesta» que hace perder el informe.
          const raw = err instanceof RoutineOutageError ? err.raw : '';
          if (raw && isOutageError(raw)) {
            const delay = delays[attempt];
            if (delay !== undefined) {
              log.info('routine retry after outage', {
                routine: ctx.routine.name,
                attempt,
                delayMs: delay,
              });
              const handle = later(() => {
                pendingRetry.delete(retryKey);
                void fire(_prompt, ctx, attempt + 1, firstAt).catch((e: unknown) =>
                  log.warn('routine retry failed', { routine: ctx.routine.name, err: e }),
                );
              }, delay);
              pendingRetry.set(retryKey, handle);
              record(
                'reintento',
                `Sin conexión con el modelo; reintento en ${retryDelayText(delay)}.`,
              );
              return;
            }
            const tried = delays.reduce((a, b) => a + b, 0);
            body = `No la he podido hacer: lo he reintentado durante ${retryDelayText(tried)} y no había conexión con el modelo (sin internet, o el servicio caído o saturado). Pídemela otra vez cuando quieras.`;
          }
        }
      }
      if (!body.trim()) {
        failed = true;
        body = 'No devolvió respuesta.';
      }
      note(() =>
        deps.onDone?.({
          scope: ctx.scope,
          name: ctx.routine.name,
          reminder: false,
          text: ctx.routine.name,
          ok: !failed,
          salida: body,
        }),
      );
      // F6: where the output goes (chat by default) and «solo si cambia».
      const setting = deps.delivery.get(ctx.scope, ctx.routine.name);
      plan = planDelivery(setting, setting.lastHash, body, failed);
      if (plan.file) {
        try {
          writeRoutineOutput(deps.outputDir, ctx.routine.name, body);
          if (!plan.chat) deps.delivery.commit(ctx.scope, ctx.routine.name, plan.hash);
        } catch (err) {
          log.warn('routine output file failed', { routine: ctx.routine.name, err });
        }
      }
      if (!plan.chat) {
        record(plan.file ? 'fichero' : plan.skipped === 'ninguno' ? 'ninguno' : 'sin-cambios');
        log.info('routine output not sent to chat', {
          routine: ctx.routine.name,
          reason: plan.skipped ?? 'fichero',
        });
        return;
      }
    }
    const text = reminder
      ? `⏰ Recordatorio: ${reminderText(ctx.routine)}`
      : `⏰ ${ctx.routine.name}${attempt > 0 && body.trim() ? lateNote(Date.now() - firstAt) : ''}\n\n${body}`;
    const buttons = reminder
      ? deps.reminderButtons?.(ctx.scope, reminderText(ctx.routine))
      : undefined;
    const sent = await (buttons ? deps.send(chatId, text, buttons) : deps.send(chatId, text))
      .then(() => true)
      .catch((err: unknown) => {
        log.warn('routine send failed', { err });
        return false;
      });
    if (sent && plan && !reminder) deps.delivery.commit(ctx.scope, ctx.routine.name, plan.hash);
    if (sent && reminder)
      note(() =>
        deps.onDone?.({
          scope: ctx.scope,
          name: ctx.routine.name,
          reminder: true,
          text: reminderText(ctx.routine),
          ok: true,
          salida: '',
        }),
      );
    if (!reminder && plan) record(sent ? 'chat' : 'pendiente');
    // La salida ya está hecha pero Telegram no la aceptó (sin red un rato, tras sus
    // reintentos de 90 s): antes se perdía (el informe de las 8:00 no llegaba). Se
    // reenvía la misma salida más tarde, sin volver a trabajar; un disparo nuevo a su
    // hora la sustituye.
    if (!sent && !reminder && plan) {
      scheduleResend({
        scope: ctx.scope,
        routine: ctx.routine.name,
        chatId,
        body,
        hash: plan.hash,
        firstAt,
        attempt: 0,
        dueAt: Date.now() + (delays[0] ?? 0),
      });
    }
    // A one-time reminder is a cron pinned to a date: it would fire again next year.
    // Deleted only once it was delivered; if Telegram failed it is retried in 5 minutes
    // instead of vanishing.
    if (isOneShotReminder(ctx.routine)) {
      const outcome = settleOneShot(store, ctx.routine, sent);
      if (outcome === 'dropped') {
        log.warn('one-time reminder dropped after an hour of failed delivery', {
          routine: ctx.routine.name,
        });
        recordDroppedReminder(deps.droppedRemindersPath, ctx.routine.name, Date.now(), chatId);
      }
      deps.sync();
    } else if (!sent && reminder) {
      // A repeating reminder that could not be sent is parked as a one-time retry
      // for this slot instead of being lost until its next day.
      try {
        parkFailedRepeating(store, ctx.routine);
        deps.sync();
      } catch (err) {
        log.warn('could not park a failed reminder for retry', { err });
      }
    } else if (sent && reminder && reminderEnded(ctx.routine, new Date(), true)) {
      // That was its last firing: remove it now so lists and the briefing stop showing it.
      store.deleteRoutine(ctx.scope, ctx.routine.name);
      deps.sync();
    }
  };
  return Object.assign((prompt: string, ctx: RoutineRunContext) => fire(prompt, ctx), {
    resumePending,
  });
}

/** « (con 7 min de retraso: a su hora no había conexión con el modelo)». */
/** Lo que se añade a la salida de una rutina que a su hora no se pudo enviar. */
export function sendLateNote(ms: number): string {
  return ` (con ${retryDelayText(Math.max(60_000, ms))} de retraso: a su hora no se pudo enviar)`;
}

export function lateNote(ms: number): string {
  return ` (con ${retryDelayText(Math.max(60_000, ms))} de retraso: a su hora no había conexión con el modelo)`;
}

export interface BootReminderDeps {
  store: Store;
  /** Envía un mensaje al chat. Rechaza si el envío falla. */
  send: (
    chatId: string,
    text: string,
    buttons?: Array<{ label: string; action: string }>,
  ) => Promise<unknown>;
  /**
   * Botones del aviso tardío («✅ Hecho» / «⏰ +1h»), los mismos que a su hora, o
   * undefined para mandarlo sin botones. Recibe el ámbito y el texto del recordatorio.
   */
  reminderButtons?: (
    scope: string,
    text: string,
  ) => Array<{ label: string; action: string }> | undefined;
  /** Arranca el planificador; se llama siempre, haya ido bien o mal la recuperación. */
  start: () => void;
  /** Tope de cada envío al arrancar (20 s por defecto). */
  sendTimeoutMs?: number;
}

/**
 * Arranque del planificador como en el daemon: los recordatorios puntuales
 * vencidos (con el PC apagado a su hora) se entregan y se borran ANTES de
 * arrancar el planificador, para que un trabajo de este minuto no dispare
 * también. Al menos una vez, nunca «exactamente una»: ver deliverMissedReminders.
 */
export function deliverMissedThenStart(deps: BootReminderDeps): Promise<void> {
  const timeoutMs = deps.sendTimeoutMs ?? 20_000;
  return deliverMissedReminders({
    store: deps.store,
    send: async (scope, text, reminder) => {
      const chatId = scope.split('#')[0]?.split(':')[2] ?? '';
      if (!chatId) return false;
      // A hung send must not keep the scheduler from starting. A timeout counts as
      // failed, but the message may still arrive: delivery is at least once.
      const timeout = new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), timeoutMs);
        t.unref?.();
      });
      const buttons = deps.reminderButtons?.(scope, reminder);
      const sent = (buttons ? deps.send(chatId, text, buttons) : deps.send(chatId, text))
        .then(() => true)
        .catch((err: unknown) => {
          log.warn('missed reminder send failed', { err });
          return false;
        });
      return Promise.race([sent, timeout]);
    },
  })
    .catch((err: unknown) => {
      log.warn('missed reminder catch-up failed', { err });
      return null;
    })
    .then((r) => {
      if (r && (r.delivered || r.failed || r.invalid)) log.info('missed reminders', r);
    })
    .finally(() => deps.start());
}

/**
 * Causa en castellano de un comando de rutina que no llegó a ejecutarse. Antes se
 * mandaba al chat el error crudo («Error: spawn x ENOENT»); el detalle queda en el log.
 */
function commandFailure(err: unknown): string {
  const raw =
    err instanceof Error
      ? `${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}`
      : String(err);
  if (/ENOENT|not found|no such file/i.test(raw)) return 'no encuentro el programa';
  if (/EACCES|EPERM|denied/i.test(raw)) return 'no tengo permiso para ejecutarlo';
  if (/ETIMEDOUT|timed? ?out/i.test(raw)) return 'tardó demasiado';
  return 'algo ha fallado por mi parte';
}
