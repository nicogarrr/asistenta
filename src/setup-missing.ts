/**
 * Mensajes en castellano para cuando falta una pieza de la instalación al
 * arrancar (`serve`, `chat`, `run`). Llevan siempre al instalador de un paso
 * (instalar.bat / scripts/instalar.mjs) y, como alternativa, a la orden exacta
 * que guarda el secreto sin ponerlo en la línea de órdenes.
 */
import { isInstalledLayout } from './actualizar-instalado.js';

export type MissingPiece = 'vault' | 'token' | 'owner';

const INSTALAR = 'Haz doble clic en instalar.bat (o ejecuta node scripts/instalar.mjs)';
/** La copia del instalador .exe no trae instalar.bat: su asistente está en el menú Inicio. */
const CONFIGURAR = 'Abre «Configurar Asistenta» en el menú Inicio de Windows';

export function missingPieceMessage(
  piece: MissingPiece,
  { instalado = isInstalledLayout(process.cwd()) } = {},
): string {
  if (instalado) {
    if (piece === 'vault')
      return `Asistenta aún no está configurada con este usuario. ${CONFIGURAR}: te pide lo necesario y la deja encendida.`;
    if (piece === 'token')
      return `Falta el token del bot de Telegram. ${CONFIGURAR} y pégalo cuando te lo pida.`;
    return `Falta tu ID de Telegram: sin él Asistenta no sabe quién eres. ${CONFIGURAR} y mándale «hola» a tu bot cuando te lo pida.`;
  }
  if (piece === 'vault')
    return `Asistenta aún no está instalada con este usuario: falta la caja fuerte de claves. ${INSTALAR}.`;
  if (piece === 'token')
    return `Falta el token del bot de Telegram. ${INSTALAR} y pégalo cuando te lo pida (o guárdalo con: pa vault set-stdin telegram:botToken).`;
  return `Falta tu ID de Telegram: sin él Asistenta no sabe quién eres. ${INSTALAR} y mándale «hola» a tu bot cuando te lo pida (o guárdalo con: pa vault set-stdin telegram:allowedUserIds).`;
}
