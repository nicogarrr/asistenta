/**
 * /stop desde Telegram y la conversación por voz: la respuesta que el PC está diciendo
 * en voz alta (speakAloud) no pasaba por la cola de /altavoz, así que /stop paraba el
 * turno pero la voz seguía hasta el final. Esto la corta, solo si la conversación es
 * de ese mismo chat (un /stop de otro chat no toca el altavoz de esta). La conversación
 * sigue abierta: /stop calla la respuesta, no cierra la sesión.
 *
 * Devuelve 1 si cortó algo (cuenta como una nota parada para la respuesta de /stop).
 */
export function stopSpokenReply(opts: {
  chatKey: string;
  sessionChatKey: string | null | undefined;
  speech: { abort(): void } | null | undefined;
  playback?: { stop(): void } | null;
}): number {
  const { speech, sessionChatKey, chatKey } = opts;
  if (!speech || !sessionChatKey || sessionChatKey !== chatKey) return 0;
  try {
    speech.abort();
  } catch {
    // Cortar es lo mejor que se puede hacer; un fallo aquí no rompe /stop.
  }
  try {
    opts.playback?.stop();
  } catch {
    // Igual.
  }
  return 1;
}
