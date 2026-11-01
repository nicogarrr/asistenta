import { localDay } from '../datecontext.js';
import type { SessionHit } from '../memory/sessions.js';

/**
 * Search hits as a short Spanish list. The title says which conversation, the
 * snippet says why it matched; nothing else is worth the screen it takes.
 */
export function formatSessionHits(hits: readonly SessionHit[], query = ''): string {
  if (!hits.length) {
    return query
      ? `No he encontrado nada sobre "${query}" en el historial de esta conversación.`
      : 'No he encontrado nada en el historial de esta conversación.';
  }
  const lines = hits.map((h) => {
    const day = localDay(new Date(h.at));
    const snippet = h.snippet.replace(/\s+/g, ' ').trim();
    return `- ${h.title.trim() || 'sin título'} (${day}): ${snippet}`;
  });
  return [`Esto es lo que encontré (${hits.length}):`, ...lines].join('\n');
}
