/**
 * Esperar a que la pantalla del iPhone se quede quieta después de un paso, en vez de una
 * pausa fija.
 *
 * Idea tomada de phoneuse (github.com/lxe/phoneuse, MIT, © 2026 Aleksey Smolenchuk,
 * phoneuse/frames.py): tras un gesto, esperar a que algo cambie y luego a que deje de
 * moverse. Reescrito, sin su código: allí comparan miniaturas de luminancia; aquí se
 * compara la firma de lo que el OCR ya lee (texto y posición, sin la barra de estado), así
 * que el puntero, el cursor de texto y el reloj no cuentan como cambio, y la última lectura
 * es la «pantalla después» (no cuesta un OCR más).
 */

import type { LineaPantalla } from './texto.js';

export interface OpcionesQuieta<T> {
  /** Una lectura de la pantalla (p. ej. el OCR de un frame). */
  leer: () => Promise<T>;
  /** Lo que se compara entre lecturas: igual = la pantalla no ha cambiado. */
  firma: (lectura: T) => string;
  /** La firma de antes del paso, si se leyó; sin ella solo se espera a dos lecturas iguales. */
  antes?: string | null;
  espera: (ms: number) => Promise<void>;
  ahora?: () => number;
  /** Lo mínimo que se deja al teléfono antes de la primera lectura. */
  minimoMs?: number;
  /** Entre lecturas. */
  intervaloMs?: number;
  /** Si nada cambia en este tiempo, se da por hecho que el paso no movió la pantalla. */
  sinCambioMs?: number;
  /** Tope total: pasado, se devuelve lo último leído aunque siga moviéndose. */
  maximoMs?: number;
}

export interface PantallaQuieta<T> {
  lectura: T;
  /** Cambió respecto a `antes`; null si no había `antes` con que comparar. */
  cambio: boolean | null;
  /** Dos lecturas seguidas iguales antes del tope. */
  quieta: boolean;
  /** Tiempo dedicado (el mayor entre el reloj y la suma de esperas). */
  ms: number;
}

export const QUIETA_MINIMO_MS = 150;
export const QUIETA_INTERVALO_MS = 250;
export const QUIETA_SIN_CAMBIO_MS = 1200;
export const QUIETA_MAXIMO_MS = 3000;

export async function esperarQuieta<T>(o: OpcionesQuieta<T>): Promise<PantallaQuieta<T>> {
  const ahora = o.ahora ?? Date.now;
  const minimo = o.minimoMs ?? QUIETA_MINIMO_MS;
  const intervalo = Math.max(o.intervaloMs ?? QUIETA_INTERVALO_MS, 1);
  const sinCambio = o.sinCambioMs ?? QUIETA_SIN_CAMBIO_MS;
  const maximo = Math.max(o.maximoMs ?? QUIETA_MAXIMO_MS, minimo);
  const t0 = ahora();
  let esperado = 0;
  const dormir = async (ms: number) => {
    esperado += ms;
    await o.espera(ms);
  };
  const pasado = () => Math.max(ahora() - t0, esperado);
  const antes = o.antes ?? null;

  await dormir(minimo);
  let lectura = await o.leer();
  let firma = o.firma(lectura);
  let cambio = antes !== null && firma !== antes;
  const dicho = () => (antes === null ? null : cambio);
  for (;;) {
    if (pasado() >= maximo) return { lectura, cambio: dicho(), quieta: false, ms: pasado() };
    if (!cambio && antes !== null && pasado() >= sinCambio) {
      return { lectura, cambio: false, quieta: true, ms: pasado() };
    }
    await dormir(intervalo);
    const otra = await o.leer();
    const otraFirma = o.firma(otra);
    const igual = otraFirma === firma;
    if (antes !== null && otraFirma !== antes) cambio = true;
    lectura = otra;
    firma = otraFirma;
    // Quieta = dos lecturas iguales DESPUÉS de haber cambiado (o, sin «antes», sin más).
    if (igual && (cambio || antes === null)) {
      return { lectura, cambio: dicho(), quieta: true, ms: pasado() };
    }
  }
}

/**
 * Firma de unas líneas de pantalla: el texto y la posición redondeada a 2 centésimas
 * (el OCR baila un píxel entre frames). Ordenadas, para que el orden de lectura no cuente.
 */
export function firmaLineas(lineas: readonly LineaPantalla[]): string {
  return lineas
    .map((l) => `${Math.round(l.x * 50)},${Math.round(l.y * 50)} ${l.texto.trim()}`)
    .sort()
    .join('\n');
}
