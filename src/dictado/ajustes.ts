/**
 * Ajustes del dictado por voz (mantener una tecla, hablar, soltar → el texto
 * se escribe en la app que tenga el foco). Todo local y apagado por defecto.
 *
 * - PA_DICTADO=1 lo enciende.
 * - PA_DICTADO_TECLA: combinación que se mantiene pulsada (por defecto ctrl+win).
 */

import { envSwitch } from '../env-flags.js';

export const TECLA_POR_DEFECTO = 'ctrl+win';

/** Teclas de Windows (códigos VK). Cada nombre vale por cualquiera de sus códigos (izq./dcha.). */
const TECLAS: Record<string, number[]> = {
  ctrl: [0x11],
  alt: [0x12],
  shift: [0x10],
  win: [0x5b, 0x5c],
  rctrl: [0xa3],
  ralt: [0xa5],
};
for (let i = 1; i <= 24; i++) TECLAS[`f${i}`] = [0x6f + i];
const MODIFICADORES = new Set([0x11, 0x12, 0x10, 0x5b, 0xa3, 0xa5]);

/**
 * «ctrl+win» → [[0x11], [0x5b, 0x5c]]: todas las teclas de la lista pulsadas a
 * la vez. null si no se entiende o si es una tecla que escribe sola (una letra
 * mantenida llenaría de letras la app).
 */
export function parseTeclaDictado(texto: string): number[][] | null {
  const partes = texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/\s*\+\s*/u)
    .map((p) => p.trim())
    .filter(Boolean);
  if (partes.length === 0 || partes.length > 3) return null;
  const teclas: number[][] = [];
  for (const p of partes) {
    const vk = TECLAS[p];
    if (!vk) return null;
    teclas.push(vk);
  }
  const soloUnModificador = teclas.length === 1 && MODIFICADORES.has(teclas[0]?.[0] ?? 0);
  return soloUnModificador ? null : teclas;
}

export interface AjustesDictado {
  activo: boolean;
  /** Tal como se escribió (o la de por defecto). */
  teclaTexto: string;
  /** null si PA_DICTADO_TECLA no se entiende. */
  tecla: number[][] | null;
  /** mantener: graba mientras está pulsada; alternar: una pulsación empieza y otra termina. */
  modo: 'mantener' | 'alternar';
}

export function ajustesDictado(env: NodeJS.ProcessEnv = process.env): AjustesDictado {
  const teclaTexto = (env.PA_DICTADO_TECLA ?? '').trim() || TECLA_POR_DEFECTO;
  return {
    activo: envSwitch(env.PA_DICTADO, false),
    teclaTexto,
    tecla: parseTeclaDictado(teclaTexto),
    modo: /^(alternar|toggle|pulsar)$/i.test((env.PA_DICTADO_MODO ?? '').trim())
      ? 'alternar'
      : 'mantener',
  };
}
