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
import { resolveSpecialist } from '../core/specialists.js';
import { sliceSafe } from '../text.js';
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
  /**
   * Un archivo que el turno manda a la conversación (documento, libro, vídeo, nota de
   * voz). Devuelve `false` si no cabe: entonces el turno lo manda por el canal, como antes.
   */
  file?(f: TurnFile): boolean;
  /** Un especialista terminó una tarea delegada (nombre canónico, ver core/specialists). */
  specialist?(name: string): void;
}

/** Un archivo enviado por un turno: los bytes y el nombre con que se descarga. */
export interface TurnFile {
  bytes: Buffer;
  name: string;
}

/** Un archivo del turno del panel tal y como lo recibe /api/chat: nombre + `data:` URL. */
export interface PanelFileLink {
  name: string;
  url: string;
}

/** Lo que devuelve un turno del panel. */
export interface PanelChatReply {
  text: string;
  images?: string[];
  files?: PanelFileLink[];
}

/** Cuántos archivos y de qué tamaño (cada uno) devuelve como mucho un turno del panel. */
export const PANEL_MAX_FILES = 4;
export const PANEL_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Tipos que el panel ofrece tal cual; cualquier otro se descarga como binario. */
const PANEL_FILE_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  mp3: 'audio/mpeg',
};

/** Nombre seguro para descargar: sin rutas ni caracteres de control, máx. 120. */
export function panelFileName(name: string): string {
  const base = sliceSafe(
    (name.split(/[\\/]/).pop() ?? '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: se quitan a propósito los caracteres de control del nombre de archivo
      .replace(/[\u0000-\u001f\u007f"<>]/g, '')
      .trim(),
    120,
  );
  return base && base !== '.' && base !== '..' ? base : 'archivo';
}

/** `data:` URL de un archivo: tipo por extensión de una lista corta; si no, binario. */
export function panelFileDataUrl(f: TurnFile): string {
  const ext = /\.([a-z0-9]+)$/i.exec(f.name)?.[1]?.toLowerCase() ?? '';
  const mime = PANEL_FILE_TYPES[ext] ?? 'application/octet-stream';
  return `data:${mime};base64,${f.bytes.toString('base64')}`;
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

/**
 * Línea final de la respuesta del panel con los especialistas que trabajaron, en
 * orden y sin repetir; un nombre que no está en el registro no sale. `null` si ninguno.
 */
export function specialistNote(names: readonly string[]): string | null {
  const titles: string[] = [];
  for (const name of names) {
    const title = resolveSpecialist(name)?.title;
    if (title && !titles.includes(title)) titles.push(title);
  }
  if (titles.length === 0) return null;
  if (titles.length === 1) return `🧩 Lo hizo el especialista ${titles[0]}.`;
  const list = `${titles.slice(0, -1).join(', ')} y ${titles[titles.length - 1]}`;
  return `🧩 Lo hicieron los especialistas ${list}.`;
}

export interface PanelChatDeps<T extends PanelChatThread> {
  /** Apunta el mensaje para /reintentar (lastTurns), ya dentro de la cola del hilo. */
  remember(thread: T, text: string): void;
  /** El turno normal del daemon, con la salida al panel en vez de a Telegram. */
  runTurn(thread: T, text: string, out: TurnOutput): Promise<void>;
  /**
   * Comando escrito que el panel contesta sin el modelo (/aprendido, /olvida <n>): su
   * respuesta, o null para el turno normal. No se apunta para /reintentar.
   */
  command?(thread: T, text: string): string | null;
}

export async function runPanelChat<T extends PanelChatThread>(
  thread: T,
  text: string,
  deps: PanelChatDeps<T>,
): Promise<PanelChatReply> {
  const out = await queueThreadTurn(thread, async () => {
    let answer = '';
    const notes: string[] = [];
    const images: string[] = [];
    const files: PanelFileLink[] = [];
    const specialists: string[] = [];
    let dropped = 0;
    const direct = deps.command?.(thread, text) ?? null;
    if (direct !== null) return { text: direct };
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
      file: (f) => {
        if (files.length >= PANEL_MAX_FILES || f.bytes.length > PANEL_MAX_FILE_BYTES) return false;
        files.push({ name: panelFileName(f.name), url: panelFileDataUrl(f) });
        return true;
      },
      specialist: (name) => {
        specialists.push(name);
      },
    });
    const worked = specialistNote(specialists);
    if (worked) notes.push(worked);
    if (dropped > 0) notes.push(`(${dropped} imagen(es) más no se muestran en el panel)`);
    const reply = [answer.trim(), ...notes].filter(Boolean).join('\n\n');
    const result: PanelChatReply = { text: reply };
    if (images.length > 0) result.images = images;
    if (files.length > 0) result.files = files;
    return result;
  });
  return out ?? { text: '' };
}
