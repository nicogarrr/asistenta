/** Startup checks and a last-resort reply boundary, with no model request. */
export function startupFailureMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  if (/no OpenRouter API key/i.test(text))
    return 'Falta la clave de OpenRouter. Configura provider:openrouterKey en el vault y reinicia.';
  if (/no Gemini API key/i.test(text))
    return 'Falta la clave de Gemini. Configura provider:geminiKey en el vault y reinicia.';
  if (/no API key/i.test(text))
    return 'Falta la clave del proveedor. Configúrala en el vault con pa vault set provider:apiKey y reinicia. Para un endpoint propio, revisa PA_API_KEY.';
  return 'No he podido preparar la respuesta. Revisa pa doctor y vuelve a intentarlo.';
}

export async function checkTelegramToken(
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('No puedo conectar con Telegram. Revisa la red y vuelve a iniciar pa serve.');
  }
  if (response.status === 401 || response.status === 404)
    throw new Error('El token de Telegram no es válido. Revisa telegram:botToken en el vault.');
  if (!response.ok)
    throw new Error(
      'Telegram no está disponible para validar el bot. Vuelve a iniciar pa serve en unos segundos.',
    );
  const data: unknown = await response.json().catch(() => null);
  if (!data || typeof data !== 'object' || !('ok' in data) || data.ok !== true)
    throw new Error('Telegram no confirmó el bot. Revisa telegram:botToken y la conexión.');
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
