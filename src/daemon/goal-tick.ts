import type { ActionLog } from '../audit/log.js';
import type { AgentRunResult, PersonalAgent } from '../core/agent.js';
import type { GoalTickResult } from '../goals/runner.js';
import { type Goal, splitGoalScope } from '../goals/store.js';
import type { SessionStore } from '../memory/sessions.js';
import type { Gate } from '../permissions.js';

/**
 * Lo que un tick de máquina (objetivo o rutina) necesita de un hilo del daemon.
 * El `Thread` de cli.ts lo cumple tal cual; el arnés e2e también.
 */
export interface TickThread {
  key: string;
  name: string;
  agent: Pick<PersonalAgent, 'attachContext' | 'run'>;
  gate: Pick<Gate, 'clearSession'>;
  /** Cola de turnos del hilo: el tick se encadena aquí, nunca se solapa con una conversación. */
  tail: Promise<unknown>;
  /** /stop la incrementa: un tick encolado antes de /stop no corre. */
  generation: number;
  active: boolean;
}

export interface ThreadTickDeps<T extends TickThread> {
  /** getOrCreateThread del daemon: (chatKey, nombre del hilo, etiqueta). */
  threadFor: (chatKey: string, threadName: string, label: string) => Promise<T>;
  sessions: Pick<SessionStore, 'begin' | 'addTurn' | 'end'>;
  /** buildContextNote del daemon para ese hilo y ese prompt. */
  contextNoteFor: (thread: T, prompt: string) => string;
  /** Contabilidad que nunca debe tumbar el tick (safeRemember de cli.ts). */
  safeRemember: (fn: () => void) => void;
}

export interface GoalTickExecuteDeps<T extends TickThread> extends ThreadTickDeps<T> {
  actions: Pick<ActionLog, 'record'>;
}

/** Etiqueta con la que se crea un hilo que aún no existe. */
export function threadLabel(threadName: string): string {
  return threadName === 'main' ? 'principal' : threadName;
}

/**
 * El `execute` del GoalRunner del daemon, sacado de serveCommand sin cambios.
 *
 * The tick rides the owning thread's tail, so it never collides with a
 * live conversation, and it runs through the thread's agent, so the gate
 * is exactly the one a chat message would face. What it does NOT do is
 * talk: no typing indicator, no progress notes, no auto-reply - a goal
 * speaks through the notifier alone (novedad o decisión).
 * The OWNING thread, not #main: the scope is a full thread key and the
 * tick must run where the goal was proposed, with that thread's agent,
 * context and gate - or objetivo:avance/reanudar would reject the tick's
 * own goal as belonging to another chat.
 */
export function createGoalTickExecute<T extends TickThread>(
  deps: GoalTickExecuteDeps<T>,
): (goal: Goal, prompt: string) => Promise<GoalTickResult> {
  const { threadFor, sessions, contextNoteFor, safeRemember, actions } = deps;
  return async (goal, prompt) => {
    const { chatKey: goalChatKey, thread: goalThreadName } = splitGoalScope(goal.scope);
    const thread = await threadFor(goalChatKey, goalThreadName, threadLabel(goalThreadName));
    const gen = thread.generation;
    const tick = async (): Promise<GoalTickResult> => {
      if (thread.generation !== gen) return { text: '', error: 'parado con /stop' };
      thread.active = true;
      let sessionId = '';
      safeRemember(() => {
        // origin 'goal-tick': the machine's own session must never count as
        // Nico's answer to a pending decision (provenance, not titles).
        sessionId = sessions.begin(
          thread.key,
          `[objetivo] ${goal.title}`.slice(0, 80),
          'goal-tick',
        );
      });
      let result: AgentRunResult | null = null;
      try {
        thread.agent.attachContext(contextNoteFor(thread, prompt));
        result = await thread.agent.run(prompt);
        safeRemember(() =>
          sessions.addTurn(sessionId, 'assistant', (result?.text ?? '').slice(0, 500)),
        );
        actions.record({
          actor: 'asistenta',
          action: 'objetivo-tick',
          target: thread.name,
          result: result?.error ? 'error' : 'ok',
          detail: `${result?.toolCalls ?? 0} tools`,
        });
        return { text: result?.text ?? '', error: result?.error ?? null };
      } catch (err) {
        return { text: '', error: err instanceof Error ? err.message : String(err) };
      } finally {
        thread.active = false;
        thread.gate.clearSession(thread.key);
        safeRemember(() => sessions.end(sessionId, (result?.text ?? '').slice(0, 200)));
      }
    };
    const next = thread.tail.then(tick);
    thread.tail = next.catch(() => {});
    return next;
  };
}
