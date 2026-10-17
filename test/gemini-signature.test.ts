import { describe, expect, it } from 'vitest';
import { createGeminiSignatureFetch } from '../src/core/gemini-signature.js';

const SIG = { google: { thought_signature: 'sig-abc' } };

function sse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Fake Gemini: turn 1 returns a tool call with a signature; turn 2 needs it echoed or answers 400. */
function fakeGemini(log: Array<{ status: number; echoed: boolean }>): typeof fetch {
  return (async (_url: unknown, init?: { body?: unknown }) => {
    const req = JSON.parse(String(init?.body));
    const assistant = req.messages.find(
      (m: { role: string; tool_calls?: unknown[] }) => m.role === 'assistant' && m.tool_calls,
    );
    if (!assistant) {
      log.push({ status: 200, echoed: false });
      return sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'reminder', arguments: '{"in":"30m"}' },
                    extra_content: SIG,
                  },
                ],
              },
            },
          ],
        },
      ]);
    }
    const echoed = JSON.stringify(assistant.tool_calls[0].extra_content) === JSON.stringify(SIG);
    if (!echoed) {
      log.push({ status: 400, echoed });
      return new Response(
        '[{"error":{"code":400,"message":"Function call is missing a thought_signature in functionCall parts."}}]',
        { status: 400 },
      );
    }
    log.push({ status: 200, echoed });
    return sse([{ choices: [{ delta: { content: 'Listo' }, finish_reason: 'stop' }] }]);
  }) as typeof fetch;
}

const turn1 = {
  model: 'gemini-3.1-flash-lite',
  messages: [{ role: 'user', content: 'recuérdame en 30 min' }],
};
const turn2 = {
  model: 'gemini-3.1-flash-lite',
  messages: [
    { role: 'user', content: 'recuérdame en 30 min' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'reminder', arguments: '{"in":"30m"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'ok' },
  ],
};
const post = (f: typeof fetch, body: unknown) =>
  f('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    method: 'POST',
    body: JSON.stringify(body),
  });

describe('Gemini 3.x thought_signature', () => {
  it('sin el envoltorio la segunda peticion es HTTP 400 (reproduce el fallo)', async () => {
    const log: Array<{ status: number; echoed: boolean }> = [];
    const f = fakeGemini(log);
    await (await post(f, turn1)).text();
    const res = await post(f, turn2);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('thought_signature');
  });

  it('con el envoltorio devuelve extra_content en el mismo tool call y responde 200', async () => {
    const log: Array<{ status: number; echoed: boolean }> = [];
    const f = createGeminiSignatureFetch(fakeGemini(log));
    const first = await post(f, turn1);
    await first.text();
    await new Promise((r) => setTimeout(r, 10));
    const res = await post(f, turn2);
    expect(res.status).toBe(200);
    expect(log).toEqual([
      { status: 200, echoed: false },
      { status: 200, echoed: true },
    ]);
  });

  it('el llamador sigue recibiendo la respuesta completa (el envoltorio solo lee una copia)', async () => {
    const f = createGeminiSignatureFetch(fakeGemini([]));
    const text = await (await post(f, turn1)).text();
    expect(text).toContain('call-1');
    expect(text).toContain('sig-abc');
  });

  it('no inventa firmas: un tool call con otro id queda igual', async () => {
    const seen: unknown[] = [];
    const inner = (async (_u: unknown, init?: { body?: unknown }) => {
      seen.push(JSON.parse(String(init?.body)));
      return sse([{ choices: [{ delta: { content: 'x' } }] }]);
    }) as typeof fetch;
    const f = createGeminiSignatureFetch(inner);
    const other = structuredClone(turn2);
    const otherCalls = (other.messages[1] as { tool_calls: Array<{ id: string }> }).tool_calls;
    (otherCalls[0] as { id: string }).id = 'call-unknown';
    await (await post(f, other)).text();
    const sent = seen[0] as {
      messages: Array<{ tool_calls?: Array<{ extra_content?: unknown }> }>;
    };
    expect(sent.messages[1]?.tool_calls?.[0]?.extra_content).toBeUndefined();
  });

  it('acepta tambien la respuesta JSON sin streaming', async () => {
    const log: unknown[] = [];
    const inner = (async (_u: unknown, init?: { body?: unknown }) => {
      const req = JSON.parse(String(init?.body));
      log.push(req.messages.length);
      if (req.messages.length === 1)
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'c9',
                    type: 'function',
                    function: { name: 'f', arguments: '{}' },
                    extra_content: SIG,
                  },
                ],
              },
            },
          ],
        });
      return Response.json({ echoed: req.messages[1].tool_calls[0].extra_content });
    }) as typeof fetch;
    const f = createGeminiSignatureFetch(inner);
    await (await post(f, turn1)).text();
    await new Promise((r) => setTimeout(r, 10));
    const second = {
      ...turn2,
      messages: turn2.messages.map((m) =>
        m.role === 'assistant'
          ? { ...m, tool_calls: [{ ...(m.tool_calls as Array<object>)[0], id: 'c9' }] }
          : m,
      ),
    };
    const body = (await (await post(f, second)).json()) as { echoed: unknown };
    expect(body.echoed).toEqual(SIG);
  });
});
