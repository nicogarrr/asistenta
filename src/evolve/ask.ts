/**
 * Pedirle una función hablando: «aprende a avisarme de la lluvia», «añádete que…»,
 * «mejórate para…», «quiero que sepas…». Se reconoce en código (no lo decide el modelo) y
 * solo en el chat privado del dueño: la idea va a la lista de hipótesis del bucle de
 * automejora, que la prueba en una copia aparte. Una pregunta («¿podrías aprender…?») pide
 * confirmación; un condicional («si aprendieras…») no hace nada y sigue al modelo.
 */

export type FeatureAsk = { kind: 'queue'; idea: string } | { kind: 'confirm'; idea: string };

const LEAD = /^(?:(?:oye|asistenta|por favor|porfa)[,\s]+)*/i;
const ASK =
  /^(?:añádete|añadete|apréndete|aprendete|enséñate|enseñate)\s+(?:que\s+|a\s+)?\S|^(?:mejórate|mejorate)\s+(?:para|en|con)\s+\S|^quiero que (?:sepas|aprendas|puedas|te añadas)\s+\S|^aprende a\s+\S/i;
const QUESTION =
  /^(?:¿\s*)?(?:podrías|podrias|puedes|sabrías|sabrias|serías capaz de|serias capaz de)\s+(?:aprender a|añadirte|mejorarte para|enseñarte a)\s+\S/i;
const CONDITIONAL = /^(?:si|cuando|ojalá|ojala|a lo mejor|quizá|quizás|quiza|quizas)\b/i;

export function detectFeatureRequest(raw: string): FeatureAsk | null {
  const text = raw.trim();
  if (!text || text.length > 400 || text.startsWith('/')) return null;
  const body = text.replace(LEAD, '');
  if (CONDITIONAL.test(body) || /^no\b/i.test(body)) return null;
  const idea = body
    .replace(/^¿\s*/, '')
    .replace(/[?¿.!\s]+$/, '')
    .trim();
  if (QUESTION.test(body)) return { kind: 'confirm', idea };
  if (!ASK.test(body)) return null;
  // «Aprende a …?» con interrogación también es una pregunta.
  if (/[?¿]/.test(text)) return { kind: 'confirm', idea };
  return { kind: 'queue', idea };
}

export const ASK_QUEUED =
  'Apuntado. Lo intento ahora en una copia aparte y te enseño el cambio antes de aplicarlo.';
export const ASK_QUEUED_BUSY =
  'Apuntado. Ya hay una mejora en marcha; lo intento en cuanto termine y te enseño el cambio antes de aplicarlo.';
export const ASK_CONFIRM = '¿Quieres que lo intente? Dime «sí» y lo pruebo en una copia aparte.';
export const ASK_DROPPED = 'Vale, no lo intento.';

const CONFIRM_MS = 10 * 60_000;

export interface FeatureAskDeps {
  /** Solo el dueño en su chat privado, con texto escrito por él (sin adjuntos). */
  isOwner: boolean;
  addHypothesis: (idea: string) => void;
  busy: () => boolean;
  /** Lanza un ciclo ahora, o lo deja en cola para cuando acabe el que está en marcha. */
  start: () => void;
  reply: (text: string) => Promise<void>;
  pending: Map<string, { idea: string; at: number }>;
  now?: () => number;
}

/** true si el mensaje era una petición (o su confirmación) y ya está contestado. */
export async function handleFeatureAsk(
  key: string,
  text: string,
  deps: FeatureAskDeps,
): Promise<boolean> {
  if (!deps.isOwner) return false;
  const now = (deps.now ?? Date.now)();
  const waiting = deps.pending.get(key);
  if (waiting) {
    deps.pending.delete(key);
    if (now - waiting.at <= CONFIRM_MS) {
      const t = text.trim().toLowerCase();
      if (/^(?:s[ií]|vale|venga|adelante|hazlo|inténtalo|intentalo)(?![\p{L}])/u.test(t)) {
        await queue(waiting.idea, deps);
        return true;
      }
      if (/^no(?![\p{L}])/u.test(t)) {
        await deps.reply(ASK_DROPPED);
        return true;
      }
    }
  }
  const ask = detectFeatureRequest(text);
  if (!ask) return false;
  if (ask.kind === 'confirm') {
    deps.pending.set(key, { idea: ask.idea, at: now });
    await deps.reply(ASK_CONFIRM);
    return true;
  }
  await queue(ask.idea, deps);
  return true;
}

async function queue(idea: string, deps: FeatureAskDeps): Promise<void> {
  const busy = deps.busy();
  deps.addHypothesis(`Petición del dueño: ${idea}`);
  await deps.reply(busy ? ASK_QUEUED_BUSY : ASK_QUEUED);
  deps.start();
}
