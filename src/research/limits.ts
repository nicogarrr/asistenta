/**
 * Límites de /investiga: cada búsqueda o lectura tiene un tope de tiempo propio
 * (una web colgada no bloquea el informe entero) y las lecturas van en paralelo
 * con un tope de concurrencia, de modo que el peor caso queda acotado.
 */

/** Tope por búsqueda o lectura; los backends tienen el suyo, esto cubre la cadena entera. */
export const DEFAULT_CALL_TIMEOUT_MS = 45_000;
/** Lecturas/búsquedas simultáneas de /investiga. */
export const RESEARCH_CONCURRENCY = 3;

export class ResearchTimeout extends Error {}

/** Ejecuta `run` y falla si tarda más de `ms` (la promesa original se abandona). */
export function bounded<T>(run: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new ResearchTimeout(`sin respuesta en ${Math.round(ms / 1000)} s`)),
      ms,
    );
    let p: Promise<T>;
    try {
      p = run();
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** `map` con como mucho `limit` tareas a la vez; conserva el orden de entrada. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
