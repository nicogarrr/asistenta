/**
 * `pa llm-health`: one probe per configured LLM provider, run from inside the
 * machine that owns the keys.
 *
 * Why this exists: LLM keys live in the vault by design and agents cannot read
 * the vault from outside. Testing a provider from elsewhere means moving the
 * secret; testing from here means the secret never leaves its store.
 *
 * COSTE: cada sonda es UNA peticion chat/completions real (max_tokens 8). Con
 * un modelo gratuito configurado es inocua; con un modelo/plan de PAGO consume
 * tokens que se facturan. No enchufar esto a un monitor automatico sin
 * comprobar el modelo/plan configurado y la autorizacion de gasto del dueño.
 *
 * Secrecy rules (the auditor tests these):
 * - Keys are collected BEFORE any probe runs, and every diagnostic string
 *   (error body, exception message, config/key-lookup failure) passes through
 *   a redactor that replaces each exact secret — plus its URL-encoded and
 *   base64 forms — with [***]. Exact match also catches short keys with
 *   symbols ("a+b=="), which a length/charset regex cannot.
 * - No key ever goes into a URL: Gemini is probed through Google's
 *   OpenAI-compatible layer with an Authorization header, matching how
 *   core/provider.ts talks to it.
 * - A failing key lookup for one provider classifies THAT provider as error
 *   and the rest still run: the report never aborts halfway.
 *
 * A 2xx is not "ok" until the body parses as a chat/completions response with
 * at least one non-empty choice; an empty or non-JSON 200 reports error with
 * a shape-only detail (response content is never printed).
 */

import { loadConfig } from './config.js';
import {
  goHeaders,
  isGoogleEndpoint,
  isOpenCodeEndpoint,
  isOpenRouterEndpoint,
} from './core/provider.js';
import { vaultGet } from './vault.js';

export type LlmStatus =
  | 'ok'
  | 'auth' // 401/403: la key no vale, no llega o el endpoint rechaza al cliente
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
  /** Short, redacted, content-free diagnostic. */
  detail?: string;
}

export function classifyHttp(http: number): LlmStatus {
  if (http >= 200 && http < 300) return 'ok';
  if (http === 401 || http === 403) return 'auth';
  if (http === 429) return 'cuota';
  return 'error';
}

/** Replaces every exact secret (and its encoded forms) with [***]. */
export function makeRedactor(secrets: string[]): (text: string) => string {
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    variants.add(secret);
    variants.add(encodeURIComponent(secret));
    variants.add(Buffer.from(secret, 'utf8').toString('base64'));
  }
  const sorted = [...variants].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = text;
    for (const v of sorted) out = out.split(v).join('[***]');
    return out;
  };
}

export interface HealthDeps {
  fetchImpl?: typeof fetch;
  getKey?: (vaultKey: string) => Promise<string | undefined>;
  env?: NodeJS.ProcessEnv;
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
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

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

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError' || /timed?\s*out/i.test(err.message))
  );
}

function isValidChatResponse(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  return choices.some((choice) => {
    const c = choice as { message?: { content?: unknown }; text?: unknown };
    const content = c?.message?.content ?? c?.text;
    if (typeof content === 'string') return content.trim().length > 0;
    if (Array.isArray(content)) {
      return content.some(
        (part) =>
          typeof (part as { text?: unknown })?.text === 'string' &&
          (part as { text: string }).text.trim().length > 0,
      );
    }
    return false;
  });
}

async function probe(
  target: ProbeTarget,
  deps: Required<HealthDeps>,
  redact: (t: string) => string,
): Promise<LlmProviderStatus> {
  const started = deps.now();
  try {
    const res = await deps.fetchImpl(target.url, {
      method: 'POST',
      headers: target.headers,
      body: JSON.stringify(target.body),
      signal: AbortSignal.timeout(deps.timeoutMs),
    });
    const latencyMs = Math.max(0, Math.round(deps.now() - started));
    let status = classifyHttp(res.status);
    let detail: string | undefined;
    if (status === 'ok') {
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = undefined;
      }
      if (!isValidChatResponse(parsed)) {
        status = 'error';
        detail = 'http 2xx sin choices de contenido (respuesta vacia o no-JSON)';
      }
    } else {
      try {
        detail = redact(await res.text()).slice(0, 160);
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
      detail: redact(err instanceof Error ? err.message : String(err)).slice(0, 120),
    };
  }
}

/**
 * Same key routing as resolveApiKey in core/provider.ts: the OpenCode key is
 * only ever used for OpenCode endpoints, OpenRouter and Gemini have their own
 * vault keys, and custom endpoints require PA_API_KEY (fail-closed).
 */
async function resolveKeyFor(
  kind: 'opencode' | 'openrouter' | 'google' | 'custom',
  deps: Required<HealthDeps>,
): Promise<string | undefined> {
  const vaultKey =
    kind === 'openrouter'
      ? 'provider:openrouterKey'
      : kind === 'google'
        ? 'provider:geminiKey'
        : kind === 'opencode'
          ? 'provider:apiKey'
          : undefined;
  if (vaultKey) {
    const fromVault = await deps.getKey(vaultKey);
    if (fromVault) return fromVault;
  }
  const envNames =
    kind === 'openrouter'
      ? ['OPENROUTER_API_KEY']
      : kind === 'google'
        ? ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
        : kind === 'opencode'
          ? ['OPENCODE_GO_API_KEY']
          : ['PA_API_KEY'];
  for (const name of envNames) {
    const v = deps.env[name]?.trim();
    if (v) return v;
  }
  return undefined;
}

function endpointKind(baseUrl: string): 'opencode' | 'openrouter' | 'google' | 'custom' {
  if (isOpenRouterEndpoint(baseUrl)) return 'openrouter';
  if (isGoogleEndpoint(baseUrl)) return 'google';
  if (isOpenCodeEndpoint(baseUrl)) return 'opencode';
  return 'custom';
}

export async function runLlmHealth(deps: HealthDeps = {}): Promise<LlmProviderStatus[]> {
  const filled: Required<HealthDeps> = {
    fetchImpl: deps.fetchImpl ?? fetch,
    getKey: deps.getKey ?? ((k) => vaultGet(k)),
    env: deps.env ?? process.env,
    now: deps.now ?? (() => Date.now()),
    timeoutMs: deps.timeoutMs ?? 20_000,
  };

  interface Planned {
    provider: string;
    model: string;
    baseUrl: string;
    kind: ReturnType<typeof endpointKind>;
    extraHeaders?: Record<string, string>;
  }

  // Plan first: every key lookup is isolated, so one vault failure classifies
  // its own provider as error and never aborts the rest of the report.
  const planned: Planned[] = [];
  const early: LlmProviderStatus[] = [];

  let config: ReturnType<typeof loadConfig> | undefined;
  try {
    config = loadConfig();
    planned.push({
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      kind: endpointKind(config.baseUrl),
      extraHeaders: isOpenCodeEndpoint(config.baseUrl) ? goHeaders('llm-health') : undefined,
    });
  } catch (err) {
    early.push({
      provider: 'configured',
      model: '?',
      status: 'error',
      latencyMs: 0,
      detail: `loadConfig: ${err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160)}`,
    });
  }

  // Extra probes: skip the one that duplicates the configured endpoint.
  if (config?.baseUrl === undefined || endpointKind(config.baseUrl) !== 'openrouter') {
    planned.push({
      provider: 'openrouter',
      model: filled.env.PA_HEALTH_OPENROUTER_MODEL?.trim() || 'thinkingmachines/inkling-small:free',
      baseUrl: OPENROUTER_BASE_URL,
      kind: 'openrouter',
    });
  }
  if (config?.baseUrl === undefined || endpointKind(config.baseUrl) !== 'google') {
    planned.push({
      provider: 'gemini',
      model: filled.env.PA_HEALTH_GEMINI_MODEL?.trim() || 'gemini-2.0-flash',
      baseUrl: GEMINI_OPENAI_BASE_URL,
      kind: 'google',
    });
  }

  // Resolve all keys up front: the redactor must know every consulted secret
  // before any probe output exists.
  const secrets: string[] = [];
  const keyed: { plan: Planned; key?: string; keyError?: string }[] = [];
  for (const plan of planned) {
    try {
      const key = await resolveKeyFor(plan.kind, filled);
      if (key) secrets.push(key);
      keyed.push({ plan, key });
    } catch (err) {
      keyed.push({
        plan,
        keyError: err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160),
      });
    }
  }
  const redact = makeRedactor(secrets);

  const targets: ProbeTarget[] = [];
  const statuses: LlmProviderStatus[] = early.map((s) => ({
    ...s,
    detail: s.detail === undefined ? undefined : redact(s.detail),
  }));
  for (const { plan, key, keyError } of keyed) {
    if (keyError) {
      statuses.push({
        provider: plan.provider,
        model: plan.model,
        status: 'error',
        latencyMs: 0,
        detail: redact(`key lookup: ${keyError}`),
      });
    } else if (!key) {
      statuses.push({
        provider: plan.provider,
        model: plan.model,
        status: 'sin-key',
        latencyMs: 0,
      });
    } else {
      targets.push(
        chatCompletionsTarget(plan.provider, plan.model, plan.baseUrl, key, plan.extraHeaders),
      );
    }
  }

  const probed = await Promise.all(targets.map((t) => probe(t, filled, redact)));
  return [...probed, ...statuses];
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
