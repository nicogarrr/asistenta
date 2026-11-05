import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BoundedMap } from '../bounded-map.js';
import { sliceSafe } from '../text.js';

/**
 * Las respuestas recientes del bot (chat:message_id → texto), para citar la que recibe
 * una reacción del dueño (telegram-reacciones.ts). Antes vivían solo en memoria: tras
 * reiniciar Asistenta (una actualización, el PC que se apaga) un 👎 a la respuesta de
 * hace un rato no hacía nada. Ahora, si se da un fichero, se guardan en disco —
 * recortadas, las últimas `max` — y se leen al arrancar.
 *
 * La escritura va agrupada (una cada `delayMs` como mucho), atómica (fichero temporal y
 * renombrado) y nunca rompe un envío: si el disco falla, sigue en memoria.
 */
export interface SentText {
  text: string;
  threadId?: string;
}

/** Lo que se guarda de cada respuesta: basta para la cita (la reacción cita 300). */
export const SENT_TEXT_KEEP_CHARS = 600;

export class SentTexts {
  readonly #map: BoundedMap<string, SentText>;
  readonly #file: string | undefined;
  readonly #delayMs: number;
  #timer: NodeJS.Timeout | null = null;
  #writing: Promise<void> = Promise.resolve();

  constructor(max: number, file?: string, delayMs = 2_000) {
    this.#map = new BoundedMap(max);
    this.#file = file;
    this.#delayMs = delayMs;
    if (file) this.#load(file);
  }

  get(key: string): SentText | undefined {
    return this.#map.get(key);
  }

  get size(): number {
    return this.#map.size;
  }

  set(key: string, value: SentText): void {
    const text = sliceSafe(value.text, SENT_TEXT_KEEP_CHARS);
    this.#map.set(key, value.threadId ? { text, threadId: value.threadId } : { text });
    this.#schedule();
  }

  /** Escribe ya lo pendiente (al parar el canal). */
  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
      this.#write();
    }
    await this.#writing;
  }

  #load(file: string): void {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return; // Primera vez, o sin fichero: se empieza vacío.
    }
    try {
      const rows: unknown = JSON.parse(raw);
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (!Array.isArray(row) || typeof row[0] !== 'string') continue;
        const v = row[1] as Partial<SentText> | undefined;
        if (!v || typeof v.text !== 'string') continue;
        this.#map.set(row[0], {
          text: v.text,
          ...(typeof v.threadId === 'string' ? { threadId: v.threadId } : {}),
        });
      }
    } catch {
      // Un fichero roto (corte de luz a medias) no impide arrancar: se empieza vacío.
    }
  }

  #schedule(): void {
    if (!this.#file || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#write();
    }, this.#delayMs);
    this.#timer.unref?.();
  }

  #write(): void {
    const file = this.#file;
    if (!file) return;
    const body = JSON.stringify([...this.#map.entries()]);
    this.#writing = this.#writing
      .then(async () => {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, body, 'utf8');
        await rename(tmp, file);
      })
      .catch(() => {});
  }
}
