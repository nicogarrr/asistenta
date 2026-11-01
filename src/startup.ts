/** Startup checks and a last-resort reply boundary, with no model request. */
export function startupFailureMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  if (/no OpenRouter API key/i.test(text))
    return 'Falta la clave de OpenRouter. Guárdala con pa vault set-stdin provider:openrouterKey (o ponla en OPENROUTER_API_KEY) y reinicia.';
  if (/no Gemini API key/i.test(text))
    return 'Falta la clave de Gemini. Guárdala con pa vault set-stdin provider:geminiKey (o ponla en GEMINI_API_KEY) y reinicia.';
  if (/no API key/i.test(text))
    return 'Falta la clave del modelo. Haz doble clic en instalar.bat (o usa pa vault set-stdin provider:apiKey) y reinicia. Para un endpoint propio, revisa PA_API_KEY.';
  return 'No he podido preparar la respuesta. Revisa pa doctor y vuelve a intentarlo.';
}

/**
 * Esperas entre intentos al arrancar `pa serve`. Tras encender o reiniciar el PC, el
 * autoarranque lanza Asistenta antes de que el Wi-Fi conecte: sin reintentos, el primer
 * «no hay red» la cerraba y no contestaba hasta la siguiente pasada del vigilante.
 */
export const SERVE_TELEGRAM_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000];

export interface TelegramCheckOptions {
  /** Una espera por reintento si no hay red o Telegram falla por su lado. Sin esto, un intento. */
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

export async function checkTelegramToken(
  token: string,
  fetcher: typeof fetch = fetch,
  opts: TelegramCheckOptions = {},
): Promise<void> {
  const delays = opts.delaysMs ?? [];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const retry = attempt < delays.length;
    let response: Response;
    try {
      response = await fetcher(`https://api.telegram.org/bot${token}/getMe`, {
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      if (retry) {
        await sleep(delays[attempt] ?? 0);
        continue;
      }
      throw new Error('No puedo conectar con Telegram. Revisa la red y vuelve a iniciar pa serve.');
    }
    if (response.status === 401 || response.status === 404)
      throw new Error('El token de Telegram no es válido. Revisa telegram:botToken en el vault.');
    if (!response.ok) {
      if (retry) {
        await sleep(delays[attempt] ?? 0);
        continue;
      }
      throw new Error(
        'Telegram no está disponible para validar el bot. Vuelve a iniciar pa serve en unos segundos.',
      );
    }
    const data: unknown = await response.json().catch(() => null);
    if (!data || typeof data !== 'object' || !('ok' in data) || data.ok !== true)
      throw new Error('Telegram no confirmó el bot. Revisa telegram:botToken y la conexión.');
    return;
  }
}

export async function withInboundFailureReply<T>(
  handle: () => Promise<T>,
  reply: (message: string) => Promise<unknown>,
  report: (error: unknown) => void,
): Promise<T | undefined> {
  try {
    return await handle();
  } catch (error) {
    report(error);
    try {
      await reply(startupFailureMessage(error));
    } catch (replyError) {
      report(replyError);
    }
    return undefined;
  }
}
