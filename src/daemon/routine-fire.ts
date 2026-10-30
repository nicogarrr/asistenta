import { isCommandRoutine } from '../command-routine.js';
import type { Store } from '../db.js';
import { isGoalRoutine } from '../goals/runner.js';
import { log } from '../log.js';
import {
  type DeliveryPlan,
  planDelivery,
  type RoutineDeliveryStore,
  writeRoutineOutput,
} from '../routine-delivery.js';
import { procedurePrompt, type RoutineRunContext } from '../routines.js';
import {
  deliverMissedReminders,
  isOneShotReminder,
  isReminder,
  oneShotStillPending,
  recordDroppedReminder,
  reminderText,
  settleOneShot,
} from '../tools/reminder.js';

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
  send: (chatId: string, text: string) => Promise<unknown>;
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
}

/**
 * Lo que hace el daemon cuando se dispara una rutina (cron, catch-up o
 * disparador por evento): tick de objetivo, recordatorio o rutina que trabaja.
 * Extraído de serveCommand (src/cli.ts) sin cambiar el comportamiento.
 */
export function createRoutineFire(
  deps: RoutineFireDeps,
): (prompt: string, ctx: RoutineRunContext) => Promise<void> {
  const { store } = deps;
  return async (_prompt: string, ctx: RoutineRunContext) => {
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
    if (!reminder) {
      let failed = false;
      if (isCommandRoutine(ctx.routine)) {
        // F4: un comando aprobado, sin modelo. Nunca se manda a runTask.
        const out = deps.fireCommand
          ? await deps.fireCommand(ctx).catch((err: unknown) => ({
              body: `No se pudo ejecutar el comando: ${String(err)}`,
              failed: true,
            }))
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
          failed = true;
          log.warn('routine execution failed', { routine: ctx.routine.name, err });
        }
      }
      if (!body.trim()) {
        failed = true;
        body = 'No devolvió respuesta.';
      }
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
        log.info('routine output not sent to chat', {
          routine: ctx.routine.name,
          reason: plan.skipped ?? 'fichero',
        });
        return;
      }
    }
    const sent = await deps
      .send(
        chatId,
        reminder
          ? `⏰ Recordatorio: ${reminderText(ctx.routine)}`
          : `⏰ Rutina "${ctx.routine.name}":\n\n${body}`,
      )
      .then(() => true)
      .catch((err: unknown) => {
        log.warn('routine send failed', { err });
        return false;
      });
    if (sent && plan && !reminder) deps.delivery.commit(ctx.scope, ctx.routine.name, plan.hash);
    // A one-time reminder is a cron pinned to a date: it would fire again next year.
    // Deleted only once it was delivered; if Telegram failed it is retried in 5 minutes
    // instead of vanishing.
    if (isOneShotReminder(ctx.routine)) {
      const outcome = settleOneShot(store, ctx.routine, sent);
      if (outcome === 'dropped') {
        log.warn('one-time reminder dropped after an hour of failed delivery', {
          routine: ctx.routine.name,
        });
        recordDroppedReminder(deps.droppedRemindersPath, ctx.routine.name);
      }
      deps.sync();
    }
  };
}

export interface BootReminderDeps {
  store: Store;
  /** Envía un mensaje al chat. Rechaza si el envío falla. */
  send: (chatId: string, text: string) => Promise<unknown>;
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
    send: async (scope, text) => {
      const chatId = scope.split('#')[0]?.split(':')[2] ?? '';
      if (!chatId) return false;
      // A hung send must not keep the scheduler from starting. A timeout counts as
      // failed, but the message may still arrive: delivery is at least once.
      const timeout = new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), timeoutMs);
        t.unref?.();
      });
      const sent = deps
        .send(chatId, text)
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
