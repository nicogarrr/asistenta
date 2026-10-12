import { describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../src/config.js';
import { classifyHttp, formatLlmHealth, runLlmHealth } from '../src/llm-health.js';

const CANARY = 'sk-canary-DO-NOT-LEAK-0123456789abcdef';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const baseEnv = {
  PA_PROVIDER: 'zen',
  PA_MODEL: 'kimi-k2.5',
  PA_BASE_URL: 'https://opencode.ai/zen/go/v1',
};

describe('classifyHttp', () => {
  it('maps the codes the report must distinguish', () => {
    expect(classifyHttp(200)).toBe('ok');
    expect(classifyHttp(401)).toBe('auth');
    expect(classifyHttp(403)).toBe('auth');
    expect(classifyHttp(429)).toBe('cuota');
    expect(classifyHttp(500)).toBe('error');
  });
});

describe('runLlmHealth', () => {
  const getKey = (k: string) => Promise.resolve(k === 'provider:apiKey' ? CANARY : undefined);

  it('reports ok for the configured provider and sin-key for the rest', async () => {
    const old = { ...process.env };
    Object.assign(process.env, baseEnv);
    resetConfigForTests();
    try {
      const statuses = await runLlmHealth({
        fetchImpl: async () => jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
        getKey,
        now: () => 0,
      });
      expect(statuses.map((s) => [s.provider, s.status])).toEqual([
        ['zen', 'ok'],
        ['openrouter', 'sin-key'],
        ['gemini', 'sin-key'],
      ]);
    } finally {
      process.env = old;
      resetConfigForTests();
    }
  });

  it('classifies 401 as auth and 429 as cuota without leaking the key', async () => {
    const old = { ...process.env };
    Object.assign(process.env, baseEnv);
    resetConfigForTests();
    try {
      const getKeyAll = () => Promise.resolve(CANARY);
      const statuses = await runLlmHealth({
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { model?: string };
          const model = body.model ?? String(_url); // gemini lleva el modelo en la URL
          // El cuerpo de error cita la key, como hacen varios proveedores.
          return jsonResponse(model.includes('free') ? 429 : 401, {
            error: { message: `bad key ${CANARY} for model ${model}` },
          });
        },
        getKey: getKeyAll,
        now: () => 0,
      });
      const out = formatLlmHealth(statuses);
      expect(statuses.find((s) => s.provider === 'zen')?.status).toBe('auth');
      expect(statuses.find((s) => s.provider === 'openrouter')?.status).toBe('cuota');
      expect(statuses.find((s) => s.provider === 'gemini')?.status).toBe('auth');
      expect(out).not.toContain(CANARY);
      expect(out).not.toContain('DO-NOT-LEAK');
    } finally {
      process.env = old;
      resetConfigForTests();
    }
  });

  it('classifies timeouts and connection failures without throwing', async () => {
    const old = { ...process.env };
    Object.assign(process.env, baseEnv);
    resetConfigForTests();
    try {
      const statuses = await runLlmHealth({
        fetchImpl: async (url) => {
          if (String(url).includes('generativelanguage'))
            throw Object.assign(new Error('fetch failed'), { name: 'TypeError' });
          throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
        },
        getKey: () => Promise.resolve(CANARY),
        now: () => 0,
      });
      expect(statuses.find((s) => s.provider === 'zen')?.status).toBe('timeout');
      expect(statuses.find((s) => s.provider === 'openrouter')?.status).toBe('timeout');
      expect(statuses.find((s) => s.provider === 'gemini')?.status).toBe('red');
    } finally {
      process.env = old;
      resetConfigForTests();
    }
  });

  it('sends the OpenCode Go headers only for the OpenCode endpoint', async () => {
    const old = { ...process.env };
    Object.assign(process.env, baseEnv);
    resetConfigForTests();
    try {
      const seen: Record<string, string>[] = [];
      await runLlmHealth({
        fetchImpl: async (_url, init) => {
          seen.push(init?.headers as Record<string, string>);
          return jsonResponse(200, {});
        },
        getKey: () => Promise.resolve(CANARY),
        now: () => 0,
      });
      expect(seen).toHaveLength(3);
      const [zen, openrouter, gemini] = seen as [
        Record<string, string>,
        Record<string, string>,
        Record<string, string>,
      ];
      expect(zen['User-Agent']).toBe('asistenta/1.0');
      expect(zen['x-opencode-session']).toBe('llm-health');
      expect(openrouter['x-opencode-session']).toBeUndefined();
      expect(gemini['x-goog-api-key']).toBe(CANARY);
      expect(gemini.Authorization).toBeUndefined();
    } finally {
      process.env = old;
      resetConfigForTests();
    }
  });
});
