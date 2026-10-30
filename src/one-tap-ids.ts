import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { setAsideCorrupt, uniqueTmpPath } from './fs-tmp.js';

/**
 * Ids cortos (8 hex) de los botones inline de un toque («✅ Hecho», «⏰ +1h», «🌅 Mañana
 * 9:00», «👀 Vigilar»…): el callback_data de Telegram lleva el id y aquí está lo que
 * apunta. Cada id vale una vez, `ttlMs` y solo desde su chat (lo comprueba quien llama).
 *
 * Con `file` se guarda en disco (tmp + rename, 0600) para que los botones sigan
 * sirviendo tras reiniciar el daemon (p. ej. tras una actualización automática). Al
 * cargar se tiran los caducados; un fichero ilegible se aparta y se empieza vacío. Si
 * no se puede escribir, los botones siguen funcionando en memoria.
 */
export class OneTapIds<T> {
  readonly #items = new Map<string, { v: T; at: number }>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #file: string | undefined;

  constructor(opts: { ttlMs: number; now?: () => number; max?: number; file?: string }) {
    this.#ttlMs = opts.ttlMs;
    this.#now = opts.now ?? Date.now;
    this.#max = opts.max ?? 200;
    this.#file = opts.file;
    this.#load();
  }

  /** Apunta `v` y devuelve su id. Tira los caducados y, si sobran, los más viejos. */
  remember(v: T): string {
    const t = this.#now();
    for (const [k, e] of this.#items) {
      if (t - e.at <= this.#ttlMs && this.#items.size < this.#max) break;
      this.#items.delete(k);
    }
    let id = randomBytes(4).toString('hex');
    while (this.#items.has(id)) id = randomBytes(4).toString('hex');
    this.#items.set(id, { v, at: t });
    this.#save();
    return id;
  }

  /** Lo saca (vale una vez) si existe, no ha caducado y `ok(v)`; si no, undefined. */
  take(id: string, ok: (v: T) => boolean): T | undefined {
    const e = this.#items.get(id);
    if (!e || this.#now() - e.at > this.#ttlMs || !ok(e.v)) return undefined;
    this.#items.delete(id);
    this.#save();
    return e.v;
  }

  #load(): void {
    if (!this.#file) return;
    let raw: string;
    try {
      raw = readFileSync(this.#file, 'utf8');
    } catch {
      return; // no existe todavía
    }
    try {
      const data = JSON.parse(raw) as Record<string, { v: T; at: number }>;
      const t = this.#now();
      const fresh = Object.entries(data)
        .filter(
          ([k, e]) =>
            /^[0-9a-f]{8}$/.test(k) &&
            typeof e?.at === 'number' &&
            t - e.at <= this.#ttlMs &&
            e.at <= t + 60_000 &&
            e.v !== undefined,
        )
        .sort((a, b) => a[1].at - b[1].at)
        .slice(-this.#max);
      for (const [k, e] of fresh) this.#items.set(k, { v: e.v, at: e.at });
    } catch {
      try {
        setAsideCorrupt(this.#file);
      } catch {
        // si ni se puede apartar, se sigue en memoria
      }
    }
  }

  #save(): void {
    if (!this.#file) return;
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      const tmp = uniqueTmpPath(this.#file);
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#items)), { mode: 0o600 });
      renameSync(tmp, this.#file);
    } catch {
      // los botones siguen sirviendo en memoria hasta reiniciar
    }
  }
}
