/**
 * /steer: cambiar las instrucciones de lo que Asistenta está haciendo SIN pararlo.
 *
 * Hoy, si ves que va por mal camino, solo puedes esperar o hacer /stop y empezar de
 * cero (perdiendo lo ya hecho). El mensaje se añade a la conversación en curso y el
 * agente lo lee en el siguiente paso, antes de la próxima llamada a una herramienta.
 *
 * Solo afecta a conversaciones de ESTE chat que están ejecutando algo ahora mismo: si
 * no hay ninguna, no se guarda para después (sería un mensaje normal con otro nombre).
 */

export interface SteerableThread {
  chatKey: string;
  active: boolean;
  agent: { steer(text: string): void };
}

export function steerChat(
  threads: Iterable<SteerableThread>,
  chatKey: string,
  text: string,
): { sent: number; error?: string } {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return { sent: 0, error: 'Dime qué cambiar: /steer <nueva instrucción>.' };
  let sent = 0;
  for (const t of threads) {
    if (t.chatKey !== chatKey || !t.active) continue;
    t.agent.steer(clean.slice(0, 2000));
    sent++;
  }
  return { sent };
}
