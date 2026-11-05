/**
 * «¿Qué recuerdas del dentista?»: primero lo apuntado en el perfil (owner-facts.ts) y, si
 * ahí no hay nada, lo que haya en el resto de la memoria (lo que se guardó hablando), al
 * momento. Antes, con el perfil vacío, la pregunta iba al modelo y tardaba un turno entero
 * en contestar lo mismo.
 */
import { aboutTopicText, entriesAbout } from './owner-facts.js';

const show = (text: string): string => {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 140 ? `${clean.slice(0, 139).trimEnd()}…` : clean;
};

export function aboutTopicAnywhere(
  profile: readonly string[],
  memory: ReadonlyArray<{ id: string; text: string }>,
  topic: string,
  max = 6,
): string | null {
  const fromProfile = aboutTopicText(profile, topic);
  if (fromProfile) return fromProfile;
  const texts = memory.map((m) => m.text);
  const hits = new Set(entriesAbout(texts, topic));
  const found = memory.filter((m) => hits.has(m.text));
  if (found.length === 0) return null;
  const last = found.slice(-max);
  const hidden = found.length - last.length;
  const label = topic.replace(/^(?:mis?|el|la|los|las)\s+/i, '');
  const more = hidden > 0 ? `\n(y ${hidden} más: /memoria buscar ${label})` : '';
  return `Sobre ${label} recuerdo de lo que hemos hablado:\n${last
    .map((m) => `• ${show(m.text)} [${m.id}]`)
    .join('\n')}${more}\n\nPara borrar uno: /memoria olvidar <código>.`;
}
