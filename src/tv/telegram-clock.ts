/**
 * La hora de Telegram, no la del PC.
 *
 * Una orden a la tele de un mensaje con más de 2 min no se hace (stale-order.ts).
 * Esa edad sale de comparar la fecha del mensaje (hora de Telegram) con la hora
 * del PC: si el reloj del PC va adelantado más de 2 min, TODAS las órdenes de
 * Telegram parecían «tardías» y se saltaban; si va atrasado, las viejas pasaban.
 *
 * Aquí se mide el desfase con lo que ya trae el sondeo (getUpdates):
 * - un lote que llega cuando el anterior ya vació la cola es «en vivo»: sus
 *   mensajes se enviaron después de la respuesta anterior, así que
 *   (hora del PC al recibirlo − fecha del mensaje más nuevo) ≈ desfase del reloj;
 * - el primer lote tras conectar puede ser cola vieja y no se usa para medir.
 * Sin medida todavía, se usa el reloj del PC, como antes.
 */

/** Un lote cuenta como «en vivo» si llega como mucho 60 s después del anterior. */
export const LIVE_BATCH_WINDOW_MS = 60_000;
const SAMPLES = 5;
const FLOORS = 200;

function updateMeta(u: unknown): { id?: number; date?: number } {
  const x = u as {
    update_id?: unknown;
    message?: { date?: unknown };
    channel_post?: { date?: unknown };
  } | null;
  const id = typeof x?.update_id === 'number' ? x.update_id : undefined;
  const raw = x?.message?.date ?? x?.channel_post?.date;
  const date = typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  return { id, date };
}

export class TelegramClock {
  /** Muestras de desfase (ms, PC − Telegram) de lotes en vivo; la menor es la buena. */
  #samples: number[] = [];
  #prevEnd: number | undefined;
  #prevDrained = false;
  /** update_id → hora del PC antes de la cual no pudo enviarse (lotes en vivo). */
  #floors = new Map<number, number>();

  /** Nueva conexión: el primer lote puede traer mensajes de cuando estaba apagada. */
  reset(): void {
    this.#prevEnd = undefined;
    this.#prevDrained = false;
  }

  /** Un getUpdates completado: sus updates y el `limit` pedido. */
  observe(updates: readonly unknown[], limit = 100, nowMs: number = Date.now()): void {
    const prev = this.#prevEnd;
    const live = this.#prevDrained && prev !== undefined && nowMs - prev <= LIVE_BATCH_WINDOW_MS;
    let newest: number | undefined;
    for (const u of updates) {
      const { id, date } = updateMeta(u);
      if (date === undefined) continue;
      newest = newest === undefined ? date : Math.max(newest, date);
      if (live && id !== undefined && prev !== undefined) this.#floors.set(id, prev - 2_000);
    }
    if (live && newest !== undefined) {
      this.#samples.push(nowMs - newest * 1000);
      if (this.#samples.length > SAMPLES) this.#samples.shift();
    }
    while (this.#floors.size > FLOORS) {
      const oldest = this.#floors.keys().next();
      if (oldest.done) break;
      this.#floors.delete(oldest.value);
    }
    this.#prevEnd = nowMs;
    this.#prevDrained = updates.length < limit;
  }

  /** Desfase estimado (PC − Telegram, ms); 0 sin medida. */
  offsetMs(): number {
    return this.#samples.length ? Math.min(...this.#samples) : 0;
  }

  /** Hora de envío de un mensaje (fecha de Telegram en s) pasada al reloj del PC. */
  sentAtMs(dateSec: number, updateId?: number): number {
    const base = dateSec * 1000 + this.offsetMs();
    const floor = updateId === undefined ? undefined : this.#floors.get(updateId);
    return floor === undefined ? base : Math.max(base, floor);
  }
}
