/**
 * /screen tv: captura de la TELE por SSAP. Un frame casi vacio es sospechoso
 * de negro (el DRM de Netflix, Prime, Disney+... bloquea la captura de video
 * en las LG de 2020+): no se manda una foto negra que no aporta; se explica
 * claro y se da la alternativa (que hay delante y volumen, en vivo).
 *
 * El tamano comprimido NO prueba DRM (puede ser una pantalla muy oscura):
 * el mensaje lo dice con honestidad, sin afirmar.
 */
import { SUSPECT_BLANK_BYTES, type TvToolDeps } from '../tools/tv.js';
import { describeTvStatus } from './status.js';

export type ScreenTvResult = { kind: 'photo'; image: Buffer } | { kind: 'text'; text: string };

export function screenTvBlankText(statusLine: string | null): string {
  const detalle = statusLine ? ` ${statusLine}` : '';
  return (
    'La tele no se deja fotografiar: la captura sale en negro. Casi siempre es el DRM ' +
    '(Netflix, Prime, Disney+... bloquean la imagen por proteccion; la tele sigue ' +
    `funcionando con normalidad), aunque tambien puede ser una pantalla muy oscura.${detalle}`
  );
}

export async function screenTvCapture(
  deps: Pick<TvToolDeps, 'shot' | 'status'>,
): Promise<ScreenTvResult> {
  const shot = await deps.shot();
  if (shot.image.length >= SUSPECT_BLANK_BYTES) {
    return { kind: 'photo', image: shot.image };
  }
  const st = await deps.status?.().catch(() => null);
  return { kind: 'text', text: screenTvBlankText(st ? describeTvStatus(st) : null) };
}
