/**
 * «Lo que te he hecho»: copia de los archivos que el asistente genera (gráficas, Excel,
 * PDF, Word…) para que salgan en la tarjeta «Páginas» del panel y se puedan bajar otra vez
 * sin pedirlos de nuevo.
 *
 * - Carpeta `creados/` del estado; nombre `AAAAMMDD-HHMMSS-<nombre seguro>`.
 * - Acotada: se quedan los 40 más nuevos y como mucho 50 MB (lo más viejo sale primero).
 * - Solo lectura desde el panel, con un id que se valida (nada de rutas ni `..`).
 */
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

export const CREADOS_MAX_FICHEROS = 40;
export const CREADOS_MAX_BYTES = 50 * 1024 * 1024;
/**
 * Fijados con «/biblioteca fijar N» (Grok Bot, «Pin» en su Library): no se podan ni
 * cuentan para los 40 / 50 MB. Como mucho 10, para que la carpeta siga acotada.
 */
export const CREADOS_MAX_FIJADOS = 10;
const FIJADOS = 'fijados.json';

const ID = /^\d{8}-\d{6}(?:-\d+)?-[A-Za-z0-9._-]{1,80}$/;

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** «Gastos de octubre.xlsx» → «Gastos-de-octubre.xlsx» (sin tildes ni rutas). */
export function nombreSeguro(nombre: string): string {
  const base = (nombre.split(/[\\/]/).pop() ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(-80);
  return base || 'archivo';
}

const stamp = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/** Orden de un id: «20261111-120000-2-x» → 20261111120000·100 + 2 (sin número = 1). */
function ordenCreado(id: string): number {
  const m = /^(\d{8})-(\d{6})(?:-(\d+))?-/.exec(id);
  return m ? Number(`${m[1]}${m[2]}`) * 100 + Number(m[3] ?? 1) : 0;
}

export interface Creado {
  id: string;
  nombre: string;
  bytes: number;
  /** Epoch ms. */
  creado: number;
}

export class CreadosStore {
  readonly #dir: string;
  readonly #now: () => number;
  constructor(dir: string, now: () => number = Date.now) {
    this.#dir = dir;
    this.#now = now;
  }

  /** Guarda una copia y poda. Nunca lanza: guardar la copia no puede impedir mandarlo. */
  guardar(bytes: Buffer | Uint8Array, nombre: string): string | null {
    try {
      mkdirSync(this.#dir, { recursive: true });
      const base = `${stamp(this.#now())}-${nombreSeguro(nombre)}`;
      let id = base;
      const head = base.slice(0, 15);
      const tail = base.slice(16);
      for (let i = 2; this.#existe(id) && i < 100; i++) id = `${head}-${i}-${tail}`;
      writeFileSync(join(this.#dir, id), bytes);
      this.#podar();
      return id;
    } catch {
      return null;
    }
  }

  #existe(id: string): boolean {
    try {
      statSync(join(this.#dir, id));
      return true;
    } catch {
      return false;
    }
  }

  /** Los más nuevos primero. */
  lista(): Creado[] {
    let names: string[];
    try {
      names = readdirSync(this.#dir);
    } catch {
      return [];
    }
    const out: Creado[] = [];
    for (const id of names) {
      if (!ID.test(id)) continue;
      try {
        const st = statSync(join(this.#dir, id));
        if (!st.isFile()) continue;
        out.push({
          id,
          nombre: id.replace(/^\d{8}-\d{6}(?:-\d+)?-/, ''),
          bytes: st.size,
          creado: st.mtimeMs,
        });
      } catch {}
    }
    // En Windows la hora de modificación avanza a saltos (~15 ms): dos guardados seguidos
    // pueden empatar. Entonces manda el id: su segundo y su número («-2-», «-10-»). Con el
    // texto del id a secas «…-2-grafica.png» (la nueva) iba detrás de «…-grafica.png».
    return out.sort(
      (a, b) =>
        b.creado - a.creado || ordenCreado(b.id) - ordenCreado(a.id) || b.id.localeCompare(a.id),
    );
  }

  /** Los ids fijados que siguen existiendo (los de un archivo ya borrado no cuentan). */
  fijados(): Set<string> {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(this.#dir, FIJADOS), 'utf8'));
    } catch {
      return new Set();
    }
    if (!Array.isArray(raw)) return new Set();
    return new Set(
      raw.filter((id): id is string => typeof id === 'string' && ID.test(id) && this.#existe(id)),
    );
  }

  #guardarFijados(ids: Set<string>): void {
    mkdirSync(this.#dir, { recursive: true });
    writeFileSync(join(this.#dir, FIJADOS), `${JSON.stringify([...ids])}\n`);
  }

  /** Fija un archivo: no se poda. 'lleno' si ya hay CREADOS_MAX_FIJADOS. */
  fijar(id: string): 'ok' | 'ya' | 'lleno' | 'no' {
    if (!ID.test(id) || !this.#existe(id)) return 'no';
    const ids = this.fijados();
    if (ids.has(id)) return 'ya';
    if (ids.size >= CREADOS_MAX_FIJADOS) return 'lleno';
    ids.add(id);
    this.#guardarFijados(ids);
    return 'ok';
  }

  /** Lo suelta: vuelve a podarse como los demás. false si no estaba fijado. */
  soltar(id: string): boolean {
    const ids = this.fijados();
    if (!ids.delete(id)) return false;
    this.#guardarFijados(ids);
    return true;
  }

  /** Bytes y tipo de un archivo para el panel; null si el id no vale o no existe. */
  leer(id: string): { bytes: Buffer; mime: string; nombre: string } | null {
    if (!ID.test(id)) return null;
    try {
      const bytes = readFileSync(join(this.#dir, id));
      const nombre = id.replace(/^\d{8}-\d{6}(?:-\d+)?-/, '');
      return {
        bytes,
        mime: MIME[extname(nombre).toLowerCase()] ?? 'application/octet-stream',
        nombre,
      };
    } catch {
      return null;
    }
  }

  #podar(): void {
    // Lo fijado no se poda ni cuenta para el tope (Grok «Pin»).
    const fijados = this.fijados();
    const all = this.lista().filter((f) => !fijados.has(f.id));
    let total = 0;
    all.forEach((f, i) => {
      total += f.bytes;
      if (i >= CREADOS_MAX_FICHEROS || (i > 0 && total > CREADOS_MAX_BYTES)) {
        try {
          unlinkSync(join(this.#dir, f.id));
        } catch {}
      }
    });
  }
}
