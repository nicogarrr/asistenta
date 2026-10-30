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
  /** Una imagen que el turno manda a la conversación (captura del PC o del navegador). */
  photo?(bytes: Buffer): void;
}

/** Cuántas imágenes devuelve como mucho un turno del panel (el resto se cuenta). */
export const PANEL_MAX_IMAGES = 4;

/** `data:` URL de una imagen PNG/JPEG; otra cosa no se muestra en el panel. */
export function imageDataUrl(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) {
    return `data:image/png;base64,${bytes.toString('base64')}`;
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
  }
  return null;
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
): Promise<{ text: string; images?: string[] }> {
  const out = await queueThreadTurn(thread, async () => {
    let answer = '';
    const notes: string[] = [];
    const images: string[] = [];
    let dropped = 0;
    deps.remember(thread, text);
    await deps.runTurn(thread, text, {
      answer: (t) => {
        answer = t;
      },
      note: (t) => {
        if (t.trim()) notes.push(t.trim());
      },
      photo: (bytes) => {
        const url = imageDataUrl(bytes);
        if (url && images.length < PANEL_MAX_IMAGES) images.push(url);
        else dropped++;
      },
    });
    if (dropped > 0) notes.push(`(${dropped} imagen(es) más no se muestran en el panel)`);
    const reply = [answer.trim(), ...notes].filter(Boolean).join('\n\n');
    return images.length > 0 ? { text: reply, images } : { text: reply };
  });
  return out ?? { text: '' };
}
