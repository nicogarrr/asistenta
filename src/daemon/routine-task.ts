import { log } from '../log.js';
import type { RoutineRunContext } from '../routines.js';
import { sliceSafe } from '../text.js';
import { type ThreadTickDeps, type TickThread, threadLabel } from './goal-tick.js';

/**
 * Ejecuta la tarea de una rutina programada en el hilo que la creó
 * (sacado de serveCommand sin cambios).
 *
 * Antes, el tick solo publicaba la FICHA de la rutina ("⏰ Rutina X: <metadatos>"),
 * así que "/cron …" o "cada mañana a las 8 resumen del día" no hacían nada: el
 * usuario veía el horario en vez del trabajo. Ahora corre por el agente del hilo
 * (mismo contexto, mismo gate y mismo presupuesto) y devuelve su respuesta, que
 * es lo que se envía. Encadenado a thread.tail como un tick de objetivo: nunca
 * se solapa con una conversación viva.
 */
export function createRoutineTask<T extends TickThread>(
  deps: ThreadTickDeps<T>,
): (prompt: string, ctx: RoutineRunContext) => Promise<string> {
  const { threadFor, sessions, contextNoteFor, safeRemember } = deps;
  return async (prompt, ctx) => {
    const [chatPart, threadRaw] = ctx.scope.split('#');
    if (!chatPart) return '';
    const threadName = threadRaw || 'main';
    const thread = await threadFor(chatPart, threadName, threadLabel(threadName));
    const generation = thread.generation;
    const task = async (): Promise<string> => {
      if (thread.generation !== generation) return '';
      thread.active = true;
      let sessionId = '';
      let text = '';
      safeRemember(() => {
        sessionId = sessions.begin(
          thread.key,
          sliceSafe(`[rutina] ${ctx.routine.name}`, 80),
          'goal-tick',
        );
      });
      try {
        thread.agent.attachContext(contextNoteFor(thread, prompt));
        const result = await thread.agent.run(prompt);
        text = result.text ?? '';
        if (result.error)
          log.warn('routine run error', { routine: ctx.routine.name, error: result.error });
        safeRemember(() => sessions.addTurn(sessionId, 'assistant', sliceSafe(text, 500)));
      } finally {
        thread.active = false;
        thread.gate.clearSession(thread.key);
        safeRemember(() => sessions.end(sessionId, sliceSafe(text, 200)));
      }
      return text;
    };
    const next = thread.tail.then(task);
    thread.tail = next.catch(() => {});
    return next;
  };
}
