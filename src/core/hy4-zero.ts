/** Temporary promotion, fail closed before exposing text or tool calls. */
export const HY4 = 'hy4-flash-free';
export const HY4_BASE = 'https://opencode.ai/inference/go/openai/v1';
const CATALOG = 'https://opencode.ai/inference/go/v1/models';
const NOTICE =
  'Hy4 bloqueado: no se puede confirmar coste cero y facturación Go. Sin modelo de respaldo.';
const promotionEnded = (): boolean => Date.now() >= Date.parse('2026-11-30T10:56:00Z');
let blocked = false;
let admitted = false;
const object = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const zero = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v === 0;
function trip(): never {
  blocked = true;
  throw new Error(NOTICE);
}

export function createHy4ZeroFetch(inner: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    if (promotionEnded() || blocked) throw new Error(NOTICE);
    if (admitted) throw new Error('Hy4 ocupado; sin modelo de respaldo.');
    admitted = true;
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== `${HY4_BASE}/chat/completions` || typeof init?.body !== 'string') trip();
      const payload = object(JSON.parse(init.body));
      if (payload.model !== HY4) trip();
      if (payload.stream === true) {
        payload.stream_options = { ...object(payload.stream_options), include_usage: true };
        init = { ...init, body: JSON.stringify(payload) };
      }
      const cat = await inner(CATALOG, { signal: AbortSignal.timeout(8000) });
      if (!cat.ok) trip();
      const data: unknown = await cat.json();
      const rows = object(data).data;
      if (!Array.isArray(rows)) trip();
      const model = object(rows.find((m: unknown) => object(m).id === HY4));
      const prices = object(object(model.cost).text);
      if (
        !zero(object(prices.input).price) ||
        !zero(object(prices.output).price) ||
        object(object(model.api)['chat-completions']).base_url !== HY4_BASE
      )
        trip();
      // Keep SDK streaming format, but buffer the full response so no tool or
      // text escapes before final billing metadata has been checked.
      if (promotionEnded() || blocked) throw new Error(NOTICE);
      const response = await inner(input, init);
      if (!response.ok) throw new Error(NOTICE);
      const text = await response.text();
      let final: Record<string, unknown> = {};
      if (text.trimStart().startsWith('{')) final = object(JSON.parse(text));
      else {
        for (const line of text.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          const chunk = object(JSON.parse(raw));
          if (chunk.usage) final = chunk;
        }
      }
      const usage = object(final.usage);
      const go = object(usage.opencode);
      if (
        final.model !== HY4 ||
        !zero(usage.cost) ||
        go.billing_source !== 'go' ||
        !zero(go.list_cost) ||
        !zero(go.allowance)
      )
        trip();
      return new Response(text, { status: response.status, headers: response.headers });
    } catch {
      return trip();
    } finally {
      admitted = false;
    }
  };
}
