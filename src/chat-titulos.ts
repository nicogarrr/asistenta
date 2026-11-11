/**
 * Nombres de los grupos de Telegram en que está Asistenta («Familia», «Inversores»…).
 *
 * El adaptador no guardaba `chat.title`, así que una regla «pregúntame antes… en este grupo»
 * se listaba desde el privado como «(solo en un grupo)», sin decir cuál. Aquí se apunta el
 * nombre que trae cada mensaje de un grupo (y se actualiza si lo renombran), para decirlo.
 * Solo nombres de chats donde ya escribe alguien autorizado; nada sale de este fichero.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { sliceSafe } from './text.js';

export const CHAT_TITULOS_MAX = 200;
const TITULO_MAX = 60;

/** El chat sin el hilo (tema del foro): «telegram:cuenta:-100123:7» → «telegram:cuenta:-100123». */
export function chatSinHilo(chatKey: string): string {
  return chatKey.split(':').slice(0, 3).join(':');
}

/** Un nombre de grupo apto para enseñar: sin saltos ni controles, recortado. '' si no vale. */
export function tituloLimpio(raw: string | undefined): string {
  if (typeof raw !== 'string') return '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: quitar controles es la idea.
  const t = raw.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]+/g, ' ');
  const clean = t.replace(/\s+/g, ' ').replace(/[«»]/g, '"').trim();
  if (!clean) return '';
  return clean.length > TITULO_MAX ? `${sliceSafe(clean, TITULO_MAX - 1)}…` : clean;
}

interface Entrada {
  titulo: string;
  visto: number;
}

export class ChatTitulos {
  readonly #file: string;
  readonly #now: () => number;
  #cache: Record<string, Entrada> | null = null;

  constructor(file: string, now: () => number = Date.now) {
    this.#file = file;
    this.#now = now;
  }

  #leer(): Record<string, Entrada> {
    if (this.#cache) return this.#cache;
    let datos: Record<string, Entrada> = {};
    try {
      const raw = JSON.parse(readFileSync(this.#file, 'utf8')) as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          const e = v as Partial<Entrada> | null;
          if (e && typeof e.titulo === 'string' && typeof e.visto === 'number')
            datos[k] = { titulo: e.titulo, visto: e.visto };
        }
      }
    } catch {
      datos = {};
    }
    this.#cache = datos;
    return datos;
  }

  /**
   * Apunta el nombre de un grupo. Solo escribe si es nuevo o ha cambiado (un mensaje por
   * segundo en un grupo no reescribe el fichero cada vez). Se quedan los 200 más recientes.
   */
  recordar(chatKey: string, raw: string | undefined): boolean {
    const titulo = tituloLimpio(raw);
    if (!titulo || !chatKey) return false;
    const key = chatSinHilo(chatKey);
    const datos = this.#leer();
    const prev = datos[key];
    const now = this.#now();
    // Reescribe el «visto» como mucho una vez al día (para la poda), o si cambia el nombre.
    if (prev && prev.titulo === titulo && now - prev.visto < 86_400_000) return false;
    datos[key] = { titulo, visto: now };
    const keys = Object.keys(datos);
    if (keys.length > CHAT_TITULOS_MAX) {
      keys
        .sort((a, b) => (datos[a]?.visto ?? 0) - (datos[b]?.visto ?? 0))
        .slice(0, keys.length - CHAT_TITULOS_MAX)
        .forEach((k) => {
          delete datos[k];
        });
    }
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      writeFileSync(tmp, JSON.stringify(datos, null, 2));
      renameSync(tmp, this.#file);
    } catch {
      // Sin nombre no pasa nada: la lista dirá «(solo en un grupo)» como antes.
    }
    return true;
  }

  /** El nombre del grupo de una chatKey (con o sin hilo); undefined si nunca lo vimos. */
  nombre(chatKey: string): string | undefined {
    return this.#leer()[chatSinHilo(chatKey)]?.titulo;
  }
}
