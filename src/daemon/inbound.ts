/**
 * Piezas del manejo de mensajes entrantes del daemon (antes dentro de
 * serveCommand en cli.ts). Movidas tal cual, sin cambio de comportamiento:
 * cli.ts las usa y el arnés e2e (test/helpers/e2e-core.ts) importa las mismas.
 */

import type { Inbound } from '../channels/types.js';

/** Telegram entrega al menos una vez: un update repetido dentro de esta ventana se ignora. */
export const SEEN_MESSAGE_TTL_MS = 3_600_000;
/** Tope de ids recordados; al pasarlo se olvida el más antiguo. */
export const SEEN_MESSAGE_MAX = 2000;

/**
 * ¿Es `key` (`<chatKey>:<messageId>`) un update ya visto hace menos de una hora?
 * Si no lo es, queda apuntado (y se olvida el más antiguo al pasar el tope).
 */
export function isDuplicateUpdate(
  seen: Map<string, number>,
  key: string,
  now: number = Date.now(),
): boolean {
  const seenAt = seen.get(key);
  if (seenAt !== undefined && now - seenAt < SEEN_MESSAGE_TTL_MS) return true;
  seen.set(key, now);
  if (seen.size > SEEN_MESSAGE_MAX) {
    const oldest = seen.keys().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return false;
}

/** Lo mínimo de un hilo para encolar turnos: su cola y su generación (/stop la sube). */
export interface QueueableThread {
  tail: Promise<unknown>;
  generation: number;
}

/**
 * Encola `work` detrás de lo que ya corre en el hilo. Hilos distintos corren a la
 * vez; dentro de un hilo, en orden. Si /stop sube la generación antes de que le
 * toque, el trabajo no corre (devuelve undefined). Un fallo no rompe la cola.
 */
export function queueThreadTurn<T>(
  thread: QueueableThread,
  work: () => Promise<T>,
): Promise<T | undefined> {
  const gen = thread.generation;
  const next = thread.tail.then(async () => {
    if (thread.generation !== gen) return undefined;
    return work();
  });
  thread.tail = next.catch(() => {});
  return next;
}

export interface InboundLog {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

export interface ReceivedAudioEntry {
  fileId: string;
  mimeType: string;
  messageId: Inbound['messageId'];
  durationSeconds?: number;
  caption?: string;
}

export interface BeginInboundDeps {
  /** Ids ya vistos (ver isDuplicateUpdate). */
  seen: Map<string, number>;
  log: InboundLog;
  /** Disparador 'mensaje' del chat (TriggerEngine.emit). */
  emitMessageTrigger: (scope: string, text: string) => Promise<unknown>;
  /** Dónde se contesta la palabra de activación y qué es «el último audio». */
  setLastChat: (chat: { key: string; chatId: string; threadId?: string }) => void;
  /** Guarda el audio recibido (media/recall). */
  recordAudio: (chatKey: string, audio: ReceivedAudioEntry) => void;
}

/**
 * Arranque de cada mensaje entrante del daemon, antes de altavoz y comandos:
 * log, descarte de updates repetidos, disparador 'mensaje' (solo texto que no
 * es comando, sin bloquear), último chat y registro del audio recibido.
 * Devuelve `null` si el update es repetido (no hay que hacer nada más).
 */
export function beginInbound(
  inbound: Inbound,
  chatKey: string,
  deps: BeginInboundDeps,
): { dedupKey: string } | null {
  deps.log.info('message', {
    chatId: inbound.chatId,
    user: inbound.displayName,
    chars: inbound.text.length,
    hasPhoto: Boolean(inbound.photoFileId),
    hasVoice: Boolean(inbound.audioFileId),
  });

  // Telegram delivers at-least-once; a redelivered update must not run the task
  // twice. Bounded by a one hour TTL, which comfortably outlives a redelivery.
  const dedupKey = `${chatKey}:${inbound.messageId}`;
  if (isDuplicateUpdate(deps.seen, dedupKey)) {
    deps.log.info('duplicate update ignored', { messageId: inbound.messageId });
    return null;
  }

  // Disparador 'mensaje': texto normal (nunca un comando) cruza los
  // triggers del chat. No bloquea la respuesta al usuario.
  if (inbound.text && !inbound.text.startsWith('/')) {
    void deps.emitMessageTrigger(chatKey, inbound.text).catch((err) => {
      deps.log.warn('trigger mensaje falló', { err: String(err) });
    });
  }

  // Where a wake word gets answered, and what "the last audio" means from now on.
  deps.setLastChat({ key: chatKey, chatId: inbound.chatId, threadId: inbound.threadId });

  // Recorded before the command dispatch, because "/play" typed as the caption of
  // an audio has to be able to find that audio by its own message id.
  if (inbound.audioFileId) {
    deps.recordAudio(chatKey, {
      fileId: inbound.audioFileId,
      mimeType: inbound.audioMimeType ?? 'audio/ogg',
      messageId: inbound.messageId,
      durationSeconds: inbound.audioDurationSeconds,
      caption: inbound.text.trim() || undefined,
    });
  }
  return { dedupKey };
}

/** «responde a ese» + salto de línea + texto: respuesta al último correo (va a /correo). */
export function isMailReplyRequest(text: string): boolean {
  return /^responde(?:r)? a ese\s*\n/i.test(text);
}
