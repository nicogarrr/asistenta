import { type FSWatcher, watch } from 'node:fs';

/**
 * Llama a `onChange` cuando cambia algo en `dir` (al momento, por eventos del sistema) y,
 * por si el aviso se pierde o la carpeta no se puede vigilar, cada `fallbackMs` igualmente.
 *
 * Sustituye a un sondeo rápido (p. ej. cada 250 ms = 4 despertares por segundo todo el día)
 * sin perder rapidez: el cambio se ve en milisegundos y el respaldo lento solo cubre el
 * caso raro. `onChange` debe aguantar que lo llamen de más (varios eventos por escritura).
 */
export function watchOrPoll(
  dir: string,
  onChange: () => void,
  fallbackMs: number,
): { close(): void; watching: () => boolean } {
  let closed = false;
  let watcher: FSWatcher | undefined;
  const fire = () => {
    if (!closed) onChange();
  };
  try {
    watcher = watch(dir, { persistent: false }, fire);
    watcher.on('error', () => {
      // Carpeta borrada, sin permiso...: queda el sondeo de respaldo.
      watcher?.close();
      watcher = undefined;
    });
  } catch {
    watcher = undefined;
  }
  const timer = setInterval(fire, fallbackMs);
  return {
    watching: () => watcher !== undefined,
    close() {
      closed = true;
      clearInterval(timer);
      watcher?.close();
      watcher = undefined;
    },
  };
}
