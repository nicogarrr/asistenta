/**
 * Lo que ve en la consola quien escribe `pa …` y algo falla antes de empezar.
 * Un usuario nuevo suele escribir solo `pa` (abre el chat) sin la clave del
 * modelo: antes veía «no API key: run … or set …» en inglés.
 */
import { startupFailureMessage } from './startup.js';

/** Mensaje final de un `pa …` que no pudo arrancar: la clave que falta, en castellano. */
export function cliFatalMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/\bno (OpenRouter |Gemini )?API key\b/i.test(text)) return startupFailureMessage(err);
  return text;
}

/** Orden desconocida: una línea clara en vez de «unknown command» y la ayuda entera. */
export function unknownCommandMessage(command: string): string {
  return `No conozco la orden «${command}». Para ver todas: pa --help (o pa ayuda)\n`;
}

/** `pa vault list`: los nombres, uno por línea; con la caja fuerte vacía, una frase que lo diga. */
export function vaultListText(names: readonly string[]): string {
  if (names.length === 0)
    return 'No hay ninguna clave guardada todavía. Para guardar una: pa vault set-stdin <nombre> (o vuelve a abrir instalar.bat)\n';
  return names.map((name) => `${name}\n`).join('');
}
