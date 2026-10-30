/**
 * Un turno del chat del panel web: corre en el hilo principal del propietario, con el
 * mismo agente, Gate y cola que Telegram, pero devuelve el texto en vez de enviarlo.
 *
 * Sacado de cli.ts tal cual (sin cambio de comportamiento) como primer paso para que el
 * panel sea un canal más (ARCHITECTURE.md §5): usa la misma cola por hilo que el resto
 * (`queueThreadTurn`), así que espera al turno vivo y se descarta si el hilo se
 * reinició (/nuevo, /borrar_chat) mientras esperaba.
 */
import { queueThreadTurn } from './inbound.js';

export interface PanelChatThread {
  key: string;
  generation: number;
  tail: Promise<unknown>;
  active: boolean;
  agent: {
    attachContext(note: string): void;
    run(text: string): Promise<{ text: string }>;
  };
  gate: { clearSession(key: string): void };
}

export async function runPanelChat(
  thread: PanelChatThread,
  text: string,
  contextNote: () => string,
): Promise<{ text: string }> {
  const out = await queueThreadTurn(thread, async () => {
    thread.active = true;
    try {
      thread.agent.attachContext(contextNote());
      const r = await thread.agent.run(text);
      return { text: r.text };
    } finally {
      thread.active = false;
      thread.gate.clearSession(thread.key);
    }
  });
  return out ?? { text: '' };
}
