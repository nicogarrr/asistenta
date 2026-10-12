/**
 * `pa llm-health`: one probe per configured LLM provider, run from inside the
 * machine that owns the keys.
 *
 * Why this exists: LLM keys live in the vault by design and agents cannot read
 * the vault from outside. Testing a provider from elsewhere means moving the
 * secret; testing from here means the secret never leaves its store. The
 * output is one line per provider with a status word, the HTTP code, and the
 * latency. It NEVER prints or logs a key, an Authorization header, or a URL
 * that carries one (Gemini's docs show key-in-query; we send x-goog-api-key
 * instead so no key ever lands in a loggable string).
 *
 * Providers probed:
 * - the configured one (`loadConfig()` provider/model/baseUrl — OpenCode Go
 *   gets its documented UA + session headers, see core/provider.ts);
 * - `openrouter` if the vault has `openrouter:apiKey` (PA_SECRET_OPENROUTER_APIKEY);
 * - `gemini` if the vault has `gemini:apiKey` (PA_SECRET_GEMINI_APIKEY).
 * A provider without a key reports `sin-key` — that is a fact about the
 * setup, not a probe failure.
 *
 * Everything external (fetch, key lookup, config load, clock) is injected so
 * the test runs offline with a fake fetch.
 */

import { loadConfig } from './config.js';
import { goHeaders, isOpenCodeEndpoint } from './core/provider.js';
import { vaultGet } from './vault.js';

export type LlmStatus =
  | 'ok'
  | 'auth' // 401/403: la key no vale o no llega
  | 'cuota' // 429: rate limit o saldo
  | 'timeout'
  | 'red' // fetch ni siquiera conecto
  | 'sin-key'
  | 'error';

export interface LlmProviderStatus {
  provider: string;
  model: string;
  status: LlmStatus;
  http?: number;
  latencyMs: number;
  /** Short, key-free diagnostic (first chars of the error body). */
  detail?: string;
}

export function classifyHttp(http: number): LlmStatus {
  if (http >= 200 && http < 300) return 'ok';
  if (http === 401 || http === 403) return 'auth';
  if (http === 429) return 'cuota';
  return 'error';
}

export interface HealthDeps {
  fetchImpl?: typeof fetch;
  getKey?: (vaultKey: string) => Promise<string | undefined>;
  now?: () => number;
  timeoutMs?: number;
}

interface ProbeTarget {
  provider: string;
  model: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const PROBE_TEXT = 'Di solo: ok';

function chatCompletionsTarget(
  provider: string,
  model: string,
  baseUrl: string,
  key: string,
  extraHeaders: Record<string, string> = {},
): ProbeTarget {
  return {
    provider,
    model,
    url: `${baseUrl.replace(/\/$/, '')}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
      ...extraHeaders,
    },
    body: { model, messages: [{ role: 'user', content: PROBE_TEXT }], max_tokens: 8 },
  };
}

function geminiTarget(model: string, key: string): ProbeTarget {
  return {
    provider: 'gemini',
    model,
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: {
      contents: [{ parts: [{ text: PROBE_TEXT }] }],
      generationConfig: { maxOutputTokens: 8 },
    },
  };
}

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError' || /timed?\s*out/i.test(err.message))
  );
}

async function probe(target: ProbeTarget, deps: Required<HealthDeps>): Promise<LlmProviderStatus> {
  const started = deps.now();
  try {
    const res = await deps.fetchImpl(target.url, {
      method: 'POST',
      headers: target.headers,
      body: JSON.stringify(target.body),
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    const latencyMs = Math.max(0, Math.round(deps.now() - started));
    const status = classifyHttp(res.status);
    let detail: string | undefined;
    if (status !== 'ok') {
      try {
        // Error bodies can quote the request: strip anything that looks like a key.
        detail = (await res.text()).replace(/[A-Za-z0-9._-]{20,}/g, '[***]').slice(0, 160);
      } catch {
        detail = undefined;
      }
    }
    return {
      provider: target.provider,
      model: target.model,
      status,
      http: res.status,
      latencyMs,
      detail,
    };
  } catch (err) {
    const latencyMs = Math.max(0, Math.round(deps.now() - started));
    return {
      provider: target.provider,
      model: target.model,
      status: isTimeoutError(err) ? 'timeout' : 'red',
      latencyMs,
      detail: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
    };
  }
}

export async function runLlmHealth(deps: HealthDeps = {}): Promise<LlmProviderStatus[]> {
  const filled: Required<HealthDeps> = {
    fetchImpl: deps.fetchImpl ?? fetch,
    getKey: deps.getKey ?? ((k) => vaultGet(k)),
    now: deps.now ?? (() => Date.now()),
    timeoutMs: deps.timeoutMs ?? 20_000,
  };

  const targets: ProbeTarget[] = [];
  const missing: LlmProviderStatus[] = [];

  // The configured provider: key and endpoint are the daemon's own by design.
  try {
    const config = loadConfig();
    const key = await filled.getKey('provider:apiKey');
    if (key) {
      targets.push(
        chatCompletionsTarget(
          config.provider,
          config.model,
          config.baseUrl,
          key,
          isOpenCodeEndpoint(config.baseUrl) ? goHeaders('llm-health') : {},
        ),
      );
    } else {
      missing.push({
        provider: config.provider,
        model: config.model,
        status: 'sin-key',
        latencyMs: 0,
      });
    }
  } catch (err) {
    missing.push({
      provider: 'configured',
      model: '?',
      status: 'error',
      latencyMs: 0,
      detail: `loadConfig: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
    });
  }

  const openRouterKey = await filled.getKey('openrouter:apiKey');
  if (openRouterKey) {
    const model = process.env.PA_HEALTH_OPENROUTER_MODEL?.trim() || 'openrouter/free';
    targets.push(
      chatCompletionsTarget('openrouter', model, 'https://openrouter.ai/api/v1', openRouterKey),
    );
  } else {
    missing.push({ provider: 'openrouter', model: '-', status: 'sin-key', latencyMs: 0 });
  }

  const geminiKey = await filled.getKey('gemini:apiKey');
  if (geminiKey) {
    const model = process.env.PA_HEALTH_GEMINI_MODEL?.trim() || 'gemini-2.0-flash';
    targets.push(geminiTarget(model, geminiKey));
  } else {
    missing.push({ provider: 'gemini', model: '-', status: 'sin-key', latencyMs: 0 });
  }

  const probed = await Promise.all(targets.map((t) => probe(t, filled)));
  return [...probed, ...missing];
}

export function formatLlmHealth(statuses: LlmProviderStatus[]): string {
  return statuses
    .map((s) => {
      const http = s.http === undefined ? '-' : String(s.http);
      const detail = s.detail ? ` :: ${s.detail}` : '';
      return `${s.provider}/${s.model}: ${s.status} (http ${http}, ${s.latencyMs}ms)${detail}`;
    })
    .join('\n');
}

export async function llmHealthCommand(): Promise<number> {
  const statuses = await runLlmHealth();
  process.stdout.write(`${formatLlmHealth(statuses)}\n`);
  return statuses.every((s) => s.status === 'ok' || s.status === 'sin-key') ? 0 : 1;
}
