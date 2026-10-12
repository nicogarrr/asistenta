import { describe, expect, it } from 'vitest';
import { resetConfigForTests } from '../src/config.js';
import { classifyHttp, formatLlmHealth, makeRedactor, runLlmHealth } from '../src/llm-health.js';

const CANARY = 'sk-canary-DO-NOT-LEAK-0123456789abcdef';
const SHORTY = 'a+b==s'; // key corta con simbolos: un regex de longitud no la pilla

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const baseEnv = {
  PA_PROVIDER: 'zen',
  PA_MODEL: 'space-bunny-free',
  PA_BASE_URL: 'https://opencode.ai/zen/v1',
} as NodeJS.ProcessEnv;

function withEnv(env: NodeJS.ProcessEnv, fn: () => Promise<void>): Promise<void> {
  const old = process.env;
  process.env = { ...old, ...env };
  resetConfigForTests();
  return fn().finally(() => {
    process.env = old;
    resetConfigForTests();
  });
}

const allKeys = (k: string) =>
  Promise.resolve(
    k === 'provider:apiKey' || k === 'provider:openrouterKey' || k === 'provider:geminiKey'
      ? CANARY
      : undefined,
  );

describe('classifyHttp', () => {
  it('maps the codes the report must distinguish', () => {
    expect(classifyHttp(200)).toBe('ok');
    expect(classifyHttp(401)).toBe('auth');
    expect(classifyHttp(403)).toBe('auth');
    expect(classifyHttp(429)).toBe('cuota');
    expect(classifyHttp(500)).toBe('error');
  });
});

describe('makeRedactor', () => {
  it('redacts the exact secret, its URL-encoded and its base64 form', () => {
    const redact = makeRedactor([SHORTY, CANARY]);
    expect(redact(`bad key ${SHORTY}`)).toBe('bad key [***]');
    expect(redact(`bad key ${encodeURIComponent(SHORTY)}`)).toBe('bad key [***]');
    expect(redact(`bad key ${Buffer.from(SHORTY).toString('base64')}`)).toBe('bad key [***]');
    expect(redact(`bad key ${CANARY}`)).toBe('bad key [***]');
    expect(redact('no secrets here')).toBe('no secrets here');
  });
});

describe('runLlmHealth', () => {
  it('ok solo con cuerpo chat/completions valido; sin-key sin claves', async () => {
    await withEnv(baseEnv, async () => {
      const statuses = await runLlmHealth({
        fetchImpl: async () => jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
        getKey: (k) => Promise.resolve(k === 'provider:apiKey' ? CANARY : undefined),
        now: () => 0,
      });
      expect(statuses.map((s) => [s.provider, s.status])).toEqual([
        ['zen', 'ok'],
        ['openrouter', 'sin-key'],
        ['gemini', 'sin-key'],
      ]);
    });
  });

  it('ADVERSARIO 2: HTTP 200 con {} o choices vacio NO es ok', async () => {
    await withEnv(baseEnv, async () => {
      const statuses = await runLlmHealth({
        fetchImpl: async (url) =>
          String(url).includes('openrouter')
            ? jsonResponse(200, {})
            : String(url).includes('generativelanguage')
              ? jsonResponse(200, { choices: [] })
              : jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
        getKey: allKeys,
        now: () => 0,
      });
      expect(statuses.find((s) => s.provider === 'zen')?.status).toBe('ok');
      expect(statuses.find((s) => s.provider === 'openrouter')?.status).toBe('error');
      expect(statuses.find((s) => s.provider === 'openrouter')?.detail).not.toContain(CANARY);
      expect(statuses.find((s) => s.provider === 'gemini')?.status).toBe('error');
    });
  });

  it('ADVERSARIO 1: una excepcion de fetch que cita la key sale redactada', async () => {
    await withEnv(baseEnv, async () => {
      const statuses = await runLlmHealth({
        fetchImpl: async () => {
          throw new Error(`connect failed, sent Authorization: Bearer ${CANARY}`);
        },
        getKey: allKeys,
        now: () => 0,
      });
      const out = formatLlmHealth(statuses);
      for (const s of statuses) expect(s.status).toBe('red');
      expect(out).not.toContain(CANARY);
      expect(out).toContain('[***]');
    });
  });

  it('ADVERSARIO 3: key corta con +/== citada en el body de un 401 sale redactada', async () => {
    await withEnv(baseEnv, async () => {
      const statuses = await runLlmHealth({
        fetchImpl: async () =>
          jsonResponse(401, { error: { message: `invalid key ${SHORTY} provided` } }),
        getKey: () => Promise.resolve(SHORTY),
        now: () => 0,
      });
      const out = formatLlmHealth(statuses);
      for (const s of statuses) expect(s.status).toBe('auth');
      expect(out).not.toContain(SHORTY);
    });
  });

  it('ADVERSARIOS 4+5: getKey que lanza NO aborta el informe y sale redactado', async () => {
    await withEnv(baseEnv, async () => {
      const statuses = await runLlmHealth({
        fetchImpl: async () => jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
        getKey: (k) =>
          k === 'provider:openrouterKey'
            ? Promise.reject(new Error(`vault corrupt near ${CANARY}`))
            : Promise.resolve(k === 'provider:apiKey' ? CANARY : undefined),
        now: () => 0,
      });
      expect(statuses.find((s) => s.provider === 'zen')?.status).toBe('ok');
      expect(statuses.find((s) => s.provider === 'gemini')?.status).toBe('sin-key');
      const or = statuses.find((s) => s.provider === 'openrouter');
      expect(or?.status).toBe('error');
      expect(formatLlmHealth(statuses)).not.toContain(CANARY);
    });
  });

  it('loadConfig roto clasifica configured como error y sigue con el resto', async () => {
    await withEnv({ ...baseEnv, PA_CRON: 'linea-sin-tabulador' }, async () => {
      const statuses = await runLlmHealth({
        fetchImpl: async () => jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }),
        getKey: () => Promise.resolve(CANARY),
        now: () => 0,
      });
      expect(statuses.find((s) => s.provider === 'configured')?.status).toBe('error');
      expect(statuses.find((s) => s.provider === 'openrouter')?.status).toBe('ok');
      expect(statuses.find((s) => s.provider === 'gemini')?.status).toBe('ok');
    });
  });

  it('classifies 401 as auth and 429 as cuota without leaking the key', async () => {
    await withEnv(baseEnv, async () => {
      const statuses = await runLlmHealth({
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { model?: string };
          const model = body.model ?? String(_url);
          return jsonResponse(model.includes('inkling') ? 429 : 401, {
            error: { message: `bad key ${CANARY} for model ${model}` },
          });
        },
        getKey: allKeys,
        now: () => 0,
      });
      const out = formatLlmHealth(statuses);
      expect(statuses.find((s) => s.provider === 'zen')?.status).toBe('auth');
      expect(statuses.find((s) => s.provider === 'openrouter')?.status).toBe('cuota');
      expect(statuses.find((s) => s.provider === 'gemini')?.status).toBe('auth');
      expect(out).not.toContain(CANARY);
      expect(out).not.toContain('DO-NOT-LEAK');
    });
  });

  it('timeout y fallo de red se clasifican sin lanzar', async () => {
    await withEnv(baseEnv, async () => {
      const statuses = await runLlmHealth({
        fetchImpl: async (url) => {
          if (String(url).includes('generativelanguage'))
            throw Object.assign(new Error('fetch failed'), { name: 'TypeError' });
          throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
        },
        getKey: allKeys,
        now: () => 0,
      });
      expect(statuses.find((s) => s.provider === 'zen')?.status).toBe('timeout');
      expect(statuses.find((s) => s.provider === 'openrouter')?.status).toBe('timeout');
      expect(statuses.find((s) => s.provider === 'gemini')?.status).toBe('red');
    });
  });

  it('cabeceras: Go lleva UA+sesion; Gemini va por capa OpenAI-compatible con Bearer', async () => {
    await withEnv(baseEnv, async () => {
      const seen: { url: string; headers: Record<string, string> }[] = [];
      await runLlmHealth({
        fetchImpl: async (url, init) => {
          seen.push({ url: String(url), headers: init?.headers as Record<string, string> });
          return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
        },
        getKey: allKeys,
        now: () => 0,
      });
      expect(seen).toHaveLength(3);
      const [zen, openrouter, gemini] = seen as [
        { url: string; headers: Record<string, string> },
        { url: string; headers: Record<string, string> },
        { url: string; headers: Record<string, string> },
      ];
      expect(zen.headers['User-Agent']).toBe('asistenta/1.0');
      expect(zen.headers['x-opencode-session']).toBe('llm-health');
      expect(openrouter.url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(openrouter.headers['x-opencode-session']).toBeUndefined();
      expect(gemini.url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      );
      expect(gemini.url).not.toContain(CANARY);
      expect(gemini.headers.Authorization).toBe(`Bearer ${CANARY}`);
    });
  });

  it('no duplica: provider configurado openrouter no genera sonda extra', async () => {
    await withEnv(
      { PA_PROVIDER: 'openrouter', PA_MODEL: 'm', PA_BASE_URL: 'https://openrouter.ai/api/v1' },
      async () => {
        const seen: string[] = [];
        const statuses = await runLlmHealth({
          fetchImpl: async (url) => {
            seen.push(String(url));
            return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
          },
          getKey: allKeys,
          now: () => 0,
        });
        expect(statuses).toHaveLength(2); // openrouter (configurado) + gemini
        expect(statuses.map((s) => s.provider).sort()).toEqual(['gemini', 'openrouter']);
        expect(seen.filter((u) => u.includes('openrouter'))).toHaveLength(1);
      },
    );
  });
});
