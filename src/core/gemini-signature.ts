/**
 * Gemini 3.x thought signatures on the OpenAI-compatible endpoint.
 *
 * Gemini 3.x attaches `extra_content.google.thought_signature` to every
 * `tool_calls[]` entry it returns. On the NEXT request the client must send
 * that object back unchanged on the same assistant tool call, or Google
 * answers HTTP 400 "Function call is missing a thought_signature".
 * pi-ai's openai-completions adapter does not keep `extra_content`, so after
 * any tool call a Gemini 3.x run died with a 400.
 *
 * This wraps `fetch` for Google endpoints only: it remembers `extra_content`
 * by tool call id from responses (JSON or SSE) and puts it back on matching
 * tool calls of the outgoing request. Nothing else in the body is touched, and
 * a tool call without a remembered signature is left as it was.
 */

type Fetch = typeof globalThis.fetch;
type Json = Record<string, unknown>;

const MAX_REMEMBERED = 512;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function createGeminiSignatureFetch(inner: Fetch = globalThis.fetch): Fetch {
  // Insertion-ordered; the oldest ids go first so a long session cannot grow it without bound.
  const remembered = new Map<string, Json>();

  const remember = (toolCalls: unknown): void => {
    if (!Array.isArray(toolCalls)) return;
    for (const call of toolCalls) {
      if (!isObject(call) || typeof call.id !== 'string' || !isObject(call.extra_content)) continue;
      remembered.delete(call.id);
      remembered.set(call.id, call.extra_content);
      if (remembered.size > MAX_REMEMBERED) {
        const oldest = remembered.keys().next().value;
        if (oldest !== undefined) remembered.delete(oldest);
      }
    }
  };

  const scanPayload = (payload: unknown): void => {
    if (!isObject(payload) || !Array.isArray(payload.choices)) return;
    for (const choice of payload.choices) {
      if (!isObject(choice)) continue;
      if (isObject(choice.message)) remember(choice.message.tool_calls);
      if (isObject(choice.delta)) remember(choice.delta.tool_calls);
    }
  };

  const scanText = (text: string): void => {
    if (text.trimStart().startsWith('{')) {
      try {
        scanPayload(JSON.parse(text));
        return;
      } catch {
        // not a single JSON document: fall through to the SSE scan
      }
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        scanPayload(JSON.parse(data));
      } catch {
        // partial or non-JSON line: ignore
      }
    }
  };

  const rewriteRequest = (body: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return body;
    }
    if (!isObject(parsed) || !Array.isArray(parsed.messages)) return body;
    let changed = false;
    for (const message of parsed.messages) {
      if (!isObject(message) || message.role !== 'assistant' || !Array.isArray(message.tool_calls))
        continue;
      for (const call of message.tool_calls) {
        if (!isObject(call) || typeof call.id !== 'string' || call.extra_content !== undefined)
          continue;
        const extra = remembered.get(call.id);
        if (extra) {
          call.extra_content = extra;
          changed = true;
        }
      }
    }
    return changed ? JSON.stringify(parsed) : body;
  };

  return (async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) => {
    const nextInit =
      init && typeof init.body === 'string' ? { ...init, body: rewriteRequest(init.body) } : init;
    const response = await inner(input, nextInit);
    if (!response.ok || !response.body) return response;
    // Read a copy; the caller gets the original stream untouched.
    const copy = response.clone();
    void copy
      .text()
      .then(scanText)
      .catch(() => undefined);
    return response;
  }) as Fetch;
}
