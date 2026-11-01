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
  return dataFileFailText(err) ?? text;
}

/**
 * Fallos de los ficheros de datos al arrancar, en castellano. Antes la consola
 * enseñaba «file is not a database» o «ENOSPC: no space left on device, open
 * 'C:\\Users\\…'» tal cual (tras un apagón o con el disco lleno pasa en Windows).
 * El detalle sigue en el registro («fatal»). null = no es de ficheros de datos.
 */
export function dataFileFailText(err: unknown): string | null {
  const e = (err ?? {}) as { code?: unknown; errcode?: unknown; errstr?: unknown };
  const raw = `${err instanceof Error ? err.message : String(err)} ${String(e.code ?? '')} ${String(e.errstr ?? '')}`;
  const sqliteCode = typeof e.errcode === 'number' ? e.errcode & 0xff : -1;
  if (/\bENOSPC\b|no space left|disk is full|SQLITE_FULL/i.test(raw) || sqliteCode === 13)
    return 'El disco está lleno y Asistenta no puede guardar sus datos. Libera espacio y vuelve a abrirla.';
  if (
    /not a database|malformed|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(raw) ||
    sqliteCode === 11 ||
    sqliteCode === 26
  )
    return 'Un fichero de datos de Asistenta está dañado (pasa a veces tras un apagón). Recupera la última copia con: pa backup restaurar ultima';
  if (/database is locked|SQLITE_BUSY|\bEBUSY\b/i.test(raw) || sqliteCode === 5)
    return 'Otro programa está usando los datos de Asistenta (¿otra Asistenta abierta, OneDrive o el antivirus?). Ciérralo y vuelve a probar.';
  if (
    /unable to open database|SQLITE_CANTOPEN|readonly database/i.test(raw) ||
    sqliteCode === 14 ||
    (/\b(EACCES|EPERM)\b/.test(raw) && /\b(open|mkdir|rename|unlink|scandir)\b/.test(raw))
  )
    return 'Windows no deja a Asistenta abrir sus datos (permiso denegado o lo tiene otro programa). Cierra lo que los use y vuelve a probar.';
  return null;
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

/** `pa vault get|rm` de un nombre que no existe. */
export function vaultMissingText(name: string): string {
  return `No hay ninguna clave guardada con el nombre «${name}». Para verlas: pa vault list\n`;
}

/** `pa vault set` con un valor de varias palabras sin comillas: llega partido. */
export function vaultSplitValueText(pieces: number): string {
  return `No he guardado nada: el valor tiene espacios y me llegó partido en ${pieces} trozos. Ponlo entre comillas ("…") o, mejor, usa pa vault set-stdin <nombre> y pégalo.\n`;
}

/** `pa vault` sin orden o con una mal escrita: ayuda corta, no la de `pa` entera. */
export function vaultUsageText(sub?: string): string {
  const head = sub ? `No conozco «${sub}» en pa vault.\n` : '';
  return `${head}Órdenes de la caja fuerte:
  pa vault set-stdin <nombre>   guardar una clave (pegas el valor y no se ve)
  pa vault list                 ver los nombres de las claves guardadas
  pa vault get <nombre>         enseñar una clave en pantalla
  pa vault rm <nombre>          borrar una clave
  pa vault init                 crear la caja fuerte cifrada
`;
}
