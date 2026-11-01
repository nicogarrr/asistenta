/**
 * Textos de `pa opengym` para la consola: castellano llano, sin nombres internos del
 * vault ni errores en crudo. El detalle técnico de un fallo inesperado va solo al
 * registro (logFile), para `pa doctor` o soporte.
 */
import { logFile } from '../log.js';
import { OpenGymError } from './client.js';

/** Línea de éxito al emparejar: dice con qué se ha emparejado, no dónde se guarda. */
export function openGymPaired(host: string): string {
  return `Listo: openGym emparejado con ${host}. He guardado el acceso de forma segura (solo lectura).`;
}

export const OPENGYM_FALLO =
  'No he podido conectar con openGym. Prueba otra vez en un momento; si sigue fallando, «pa doctor» te ayuda a ver qué pasa.';

/**
 * Qué decir en consola cuando `pa opengym` falla. Los OpenGymError ya traen un motivo en
 * castellano; cualquier otro error (vault, sistema…) se guarda en el registro y en
 * pantalla sale una sola línea clara.
 */
export function openGymCliError(err: unknown): string {
  if (err instanceof OpenGymError) return err.message;
  logFile.error('opengym: fallo inesperado en la orden', {
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  });
  return OPENGYM_FALLO;
}
