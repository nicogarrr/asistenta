/**
 * `pa doctor` no decía nada de Telegram, que es lo primero que falla en un PC
 * nuevo: sin token del bot o sin el ID del dueño Asistenta no arranca, y el
 * doctor salía «limpio». Estas líneas lo dicen en castellano llano, sin mostrar
 * nunca el token, con las mismas reglas que el daemon al arrancar.
 */

type VaultRead = (key: string) => Promise<string | undefined | null>;

/** Lo mínimo de `fetch` que usa la prueba en vivo (los tests pasan uno falso). */
export type DoctorFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Tiempo máximo de la prueba en vivo: el doctor no se queda colgado sin red. */
export const LIVE_TIMEOUT_MS = 4000;

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

/**
 * Prueba de verdad el token con getMe de Telegram. Nunca muestra el token ni el
 * error crudo (la URL lleva el token). Sin red no falla: solo lo dice.
 */
export async function telegramLiveLine(
  token: string,
  fetcher: DoctorFetch,
  timeoutMs = LIVE_TIMEOUT_MS,
): Promise<string> {
  const sinRed =
    'telegram        no he podido hablar con Telegram ahora (¿sin internet?); el token se comprobará al arrancar';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limite = new Promise<'timeout'>((res) => {
    timer = setTimeout(() => res('timeout'), timeoutMs);
    timer.unref?.();
  });
  try {
    const res = await Promise.race([
      fetcher(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.timeout(timeoutMs),
      }),
      limite,
    ]);
    if (res === 'timeout') return sinRed;
    if (res.status === 401 || res.status === 404) {
      return `telegram        Telegram dice que este token no vale: pide uno nuevo a @BotFather y pégalo con ${INSTALAR}`;
    }
    if (!res.ok)
      return 'telegram        Telegram no responde bien ahora; vuelve a probar pa doctor en un rato';
    const data = (await Promise.race([res.json().catch(() => null), limite])) as {
      ok?: unknown;
      result?: { username?: unknown };
    } | null;
    if (!data || data === ('timeout' as unknown) || data.ok !== true) {
      return `telegram        Telegram no ha confirmado el bot: vuelve a pegar el token con ${INSTALAR}`;
    }
    const user = data.result?.username;
    return typeof user === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(user)
      ? `telegram        Telegram reconoce tu bot @${user}`
      : 'telegram        Telegram reconoce tu bot';
  } catch {
    return sinRed;
  } finally {
    clearTimeout(timer);
  }
}

/** `fetch` para el doctor, salvo que se pida sin red (PA_DOCTOR_SIN_RED=1). */
export function doctorFetch(env: NodeJS.ProcessEnv = process.env): DoctorFetch | undefined {
  return env.PA_DOCTOR_SIN_RED === '1' ? undefined : (url, init) => fetch(url, init);
}

export async function telegramDoctorLines(
  get: VaultRead,
  fetcher?: DoctorFetch,
): Promise<string[]> {
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
    if (fetcher) lines.push(await telegramLiveLine(token.trim(), fetcher));
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
