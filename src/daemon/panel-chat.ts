/**
 * Un turno del chat del panel web: corre en el hilo principal del propietario, con el
 * mismo agente, Gate y cola que Telegram, pero devuelve el texto en vez de enviarlo.
 *
 * Paso 2 (ARCHITECTURE.md §5): el panel ya no lleva su propio mini-turno. Usa el turno
 * normal del daemon (`runTurn`) con un puerto de salida que recoge el texto: el turno
 * queda registrado en el historial de sesiones (/buscar), en las acciones y en el
 * presupuesto, pasa por la misma marca de contenido privado del Gate, y /reintentar lo
 * ve. Nada de lo que el turno diría por Telegram (notas de progreso, avisos, errores)
 * sale por Telegram: vuelve al panel con la respuesta.
 *
 * Usa la misma cola por hilo que el resto (`queueThreadTurn`), así que espera al turno
 * vivo y se descarta si el hilo se reinició (/nuevo, /borrar_chat) mientras esperaba.
 */
import { queueThreadTurn } from './inbound.js';

export interface PanelChatThread {
  key: string;
  generation: number;
  tail: Promise<unknown>;
  active: boolean;
}

/** Dónde deja un turno lo que diría por el canal: la respuesta y los avisos sueltos. */
export interface TurnOutput {
  /** La respuesta final del turno (una vez). */
  answer(text: string): void;
  /** Un aviso aparte (presupuesto, sugerencia de memoria, error). */
  note(text: string): void;
}

export interface PanelChatDeps<T extends PanelChatThread> {
  /** Apunta el mensaje para /reintentar (lastTurns), ya dentro de la cola del hilo. */
  remember(thread: T, text: string): void;
  /** El turno normal del daemon, con la salida al panel en vez de a Telegram. */
  runTurn(thread: T, text: string, out: TurnOutput): Promise<void>;
}

export async function runPanelChat<T extends PanelChatThread>(
  thread: T,
  text: string,
  deps: PanelChatDeps<T>,
): Promise<{ text: string }> {
  const out = await queueThreadTurn(thread, async () => {
    let answer = '';
    const notes: string[] = [];
    deps.remember(thread, text);
    await deps.runTurn(thread, text, {
      answer: (t) => {
        answer = t;
      },
      note: (t) => {
        if (t.trim()) notes.push(t.trim());
      },
    });
    return { text: [answer.trim(), ...notes].filter(Boolean).join('\n\n') };
  });
  return out ?? { text: '' };
}
