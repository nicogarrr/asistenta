/**
 * Durable /learn recording state (capability 3, PR4).
 *
 * An array index is not the identity of "where the demonstration started": the
 * agent compacts and replaces its message array, and a context note is removed
 * and re-appended every turn. So a recording keeps (a) the OBJECT of the last
 * real message before it started, verified by identity at the end; (b) the
 * agent instance and its compaction counter, so a compaction or a rebuilt
 * agent in between aborts instead of summarising a different segment. Any
 * doubt refuses: a wrong macro is worse than asking to record again.
 */
export interface LearnTranscriptSource {
  readonly messages: readonly unknown[];
  readonly compactions: number;
}

interface Recording {
  name: string;
  threadKey: string;
  agent: LearnTranscriptSource;
  compactions: number;
  /** Last user/assistant/tool message before the start; null = empty history. */
  boundary: unknown;
}

export type LearnEnd =
  | { ok: true; name: string; segment: unknown[] }
  | { ok: false; reason: 'none' | 'other-thread' | 'unanchored'; name?: string };

function isRealMessage(m: unknown): boolean {
  const role = (m as { role?: unknown } | null)?.role;
  return role === 'user' || role === 'assistant' || role === 'toolResult';
}

/**
 * «ya está», «listo», «he terminado»… dicho suelto mientras se graba cierra la
 * grabación igual que `/learn end` (Nico, 1 nov: hablar normal, sin comandos).
 * Solo frases cortas y enteras: «ya está el correo enviado» sigue siendo demo.
 */
export const LEARN_END_RESPUESTA =
  /^(?:ya\s+est[áa]|list[oa]|fin|(?:ya\s+)?(?:he\s+)?(?:terminado|acabado)|(?:ya\s+)?(?:termin[ée]|acab[ée])|(?:para|deja)\s+de\s+grabar)\s*[.!¡]*\s*$/iu;

export class LearnRecorder {
  readonly #byChat = new Map<string, Recording>();

  /** ¿Hay una grabación en curso en este chat? */
  isRecording(chatId: string): boolean {
    return this.#byChat.has(chatId);
  }

  start(chatId: string, name: string, threadKey: string, agent: LearnTranscriptSource): void {
    let boundary: unknown = null;
    for (let i = agent.messages.length - 1; i >= 0; i--) {
      const m = agent.messages[i];
      if (isRealMessage(m)) {
        boundary = m;
        break;
      }
    }
    this.#byChat.set(chatId, {
      name,
      threadKey,
      agent,
      compactions: agent.compactions,
      boundary,
    });
  }

  /** Wrong-topic attempts keep the recording; an unanchorable one is dropped. */
  end(chatId: string, threadKey: string, agent: LearnTranscriptSource): LearnEnd {
    const rec = this.#byChat.get(chatId);
    if (!rec) return { ok: false, reason: 'none' };
    if (rec.threadKey !== threadKey) return { ok: false, reason: 'other-thread', name: rec.name };
    this.#byChat.delete(chatId);
    if (rec.agent !== agent || agent.compactions !== rec.compactions) {
      return { ok: false, reason: 'unanchored', name: rec.name };
    }
    const messages = agent.messages;
    let from = 0;
    if (rec.boundary !== null) {
      const at = messages.indexOf(rec.boundary);
      if (at < 0) return { ok: false, reason: 'unanchored', name: rec.name };
      from = at + 1;
    }
    return { ok: true, name: rec.name, segment: messages.slice(from) };
  }
}
