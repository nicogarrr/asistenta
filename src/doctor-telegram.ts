/**
 * `pa doctor` no decía nada de Telegram, que es lo primero que falla en un PC
 * nuevo: sin token del bot o sin el ID del dueño Asistenta no arranca, y el
 * doctor salía «limpio». Estas líneas lo dicen en castellano llano, sin mostrar
 * nunca el token, con las mismas reglas que el daemon al arrancar.
 */

type VaultRead = (key: string) => Promise<string | undefined | null>;

/** Forma de un token de bot de Telegram: número, dos puntos y la clave. */
const BOT_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

const INSTALAR = 'doble clic en instalar.bat';

/** Los ID que el daemon aceptaría (mismo criterio que serve). */
export function allowedTelegramIds(raw: string | undefined | null): number[] {
  return (raw ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export async function telegramDoctorLines(get: VaultRead): Promise<string[]> {
  let token: string | undefined | null;
  let ids: string | undefined | null;
  try {
    token = await get('telegram:botToken');
    ids = await get('telegram:allowedUserIds');
  } catch {
    return ['telegram        no pude leer la caja fuerte de claves; mira la línea «claves»'];
  }
  const lines: string[] = [];
  if (!token?.trim()) {
    lines.push(
      `telegram        FALTA el token del bot: ${INSTALAR} (o pa vault set-stdin telegram:botToken)`,
    );
  } else if (!BOT_TOKEN.test(token)) {
    lines.push(
      `telegram        el token guardado no parece de un bot (es como 123456:ABC…): vuelve a pegarlo con ${INSTALAR}`,
    );
  } else {
    lines.push('telegram        token del bot guardado');
  }
  const allowed = allowedTelegramIds(ids);
  if (allowed.length > 0) {
    lines.push(
      `dueño           ${allowed.length === 1 ? '1 persona autorizada' : `${allowed.length} personas autorizadas`}`,
    );
  } else if (ids?.trim()) {
    lines.push(
      `dueño           el ID guardado no es un número de Telegram: ${INSTALAR} y escribe «hola» a tu bot`,
    );
  } else {
    lines.push(
      `dueño           FALTA tu ID de Telegram: ${INSTALAR} y escribe «hola» a tu bot (o pa vault set-stdin telegram:allowedUserIds)`,
    );
  }
  return lines;
}
