import type { PriceNotifyOpts } from './pricewatch.js';
import type { CycleLog } from './pricewatch-runner.js';

/**
 * Identity fallback is explicit, same chat only. Never log credentials or provider bodies.
 * Los botones (p. ej. «🔕 Silenciar 1 día») solo viajan cuando avisa el bot principal: la
 * pulsación llega al bot que envió el mensaje, y solo el principal la atiende. Si avisa otro
 * bot, el aviso lleva en su lugar la orden escrita (p. ej. «/precio silenciar a1b2c3d4»).
 */
export function typedButtonsHint(buttons: Array<{ label: string; action: string }>): string {
  return buttons
    .filter((b) => b.action.startsWith('cmd:'))
    .map((b) => `${b.label}: escribe /${b.action.slice(4)} al bot principal de Asistenta.`)
    .join('\n');
}

export function pricewatchNotifier(opts: {
  token: string;
  mainBotToken: string;
  chatId: string;
  out: (text: string) => Promise<void>;
  log: CycleLog;
  send?: typeof fetch;
}): (text: string, opts?: PriceNotifyOpts) => Promise<void> {
  return async (text, opts2) => {
    await opts.out(text);
    const hint = opts.mainBotToken && opts2?.buttons?.length ? typedButtonsHint(opts2.buttons) : '';
    const textFor = (token: string) =>
      hint && token !== opts.mainBotToken ? `${text}\n\n${hint}` : text;
    const send = async (token: string) =>
      (opts.send ?? fetch)(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: opts.chatId,
          text: textFor(token),
          disable_web_page_preview: true,
          ...(token === opts.mainBotToken && opts2?.buttons?.length
            ? {
                reply_markup: {
                  inline_keyboard: [
                    opts2.buttons.map((b) => ({ text: b.label, callback_data: b.action })),
                  ],
                },
              }
            : {}),
        }),
      });
    try {
      if (!opts.token && !opts.mainBotToken) {
        opts.log.warn('pricewatch: sin token legible');
        return;
      }
      const result = await send(opts.token || opts.mainBotToken);
      if (
        result.status === 401 &&
        opts.token &&
        opts.mainBotToken &&
        opts.token !== opts.mainBotToken
      ) {
        const retry = await send(opts.mainBotToken);
        if (!retry.ok)
          opts.log.warn('pricewatch: bot principal no pudo avisar', { status: retry.status });
      } else if (!result.ok)
        opts.log.warn('pricewatch: Telegram no pudo avisar', { status: result.status });
    } catch {
      opts.log.warn('pricewatch: Telegram sin conexión');
    }
  };
}
