import type { CycleLog } from './pricewatch-runner.js';

/** Identity fallback is explicit, same chat only. Never log credentials or provider bodies. */
export function pricewatchNotifier(opts: {
  token: string;
  mainBotToken: string;
  chatId: string;
  out: (text: string) => Promise<void>;
  log: CycleLog;
  send?: typeof fetch;
}): (text: string) => Promise<void> {
  return async (text) => {
    await opts.out(text);
    const send = async (token: string) =>
      (opts.send ?? fetch)(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: opts.chatId, text, disable_web_page_preview: true }),
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
