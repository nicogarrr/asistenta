import type { Model, MutableModels } from '@earendil-works/pi-ai';
import { createModels, envApiKeyAuth, normalizeContext } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { createProvider } from '@earendil-works/pi-ai/models';
import type { Config } from '../config.js';
import { log } from '../log.js';
import { vaultGet } from '../vault.js';
import { createGeminiSignatureFetch } from './gemini-signature.js';
import { createOpenCodeLocalStream, DEFAULT_OPENCODE_LOCAL } from './opencode-local.js';

/**
 * Provider wiring.
 *
 * `space-bunny-free` is not in pi-ai's bundled catalog, so we register the model
 * ourselves against the OpenAI-compatible adapter. Two things this file is
 * responsible for that are easy to get wrong:
 *
 * 1. Auth goes through a custom `authContext`, not `process.env`. The key lives in
 *    the vault and is fetched per run, so rotating a secret does not need a restart.
 * 2. `auth` is `{ apiKey: ... }`. Passing the `ApiKeyAuth` object directly compiles
 *    fine and fails at request time with "Provider is not configured".
 */
export interface ProviderHandle {
  models: MutableModels;
  model: Model<string>;
  /** Stream function for the agent: adds the per-conversation session header Go requires. */
  streamFn: MutableModels['streamSimple'];
  /** The model with the Go client headers for one session (identity for other endpoints). */
  modelFor: (sessionId?: string) => Model<string>;
  /**
   * The configured quota fallback (config.fallbackModel), same endpoint and
   * auth, with the same per-session Go headers. Undefined when no fallback is
   * configured: agent code must not invent one.
   */
  fallbackFor?: (sessionId?: string) => Model<string>;
}

/** Identifies this client to OpenCode Go (own user agent, never a generic SDK name). */
export const CLIENT_USER_AGENT = 'asistenta/1.0';

/** True for the OpenCode Go endpoint, which documents the client + session-header rules. */
export function isGoEndpoint(baseUrl: string): boolean {
  return /\/zen\/go(\/|$)/.test(baseUrl);
}

/** True for any OpenCode endpoint (Zen or Go): both document the own-UA + session rules. */
export function isOpenCodeEndpoint(baseUrl: string): boolean {
  return /^https:\/\/opencode\.ai\/zen(\/|$)/.test(baseUrl);
}

/** True for the OpenRouter endpoint. */
export function isOpenRouterEndpoint(baseUrl: string): boolean {
  return /^https:\/\/openrouter\.ai(\/|$)/.test(baseUrl);
}

/** True for Google's Gemini endpoints (OpenAI-compatible layer or native). */
export function isGoogleEndpoint(baseUrl: string): boolean {
  return /^https:\/\/generativelanguage\.googleapis\.com(\/|$)/.test(baseUrl);
}

/**
 * OpenCode Go asks API clients to send their own user agent and a stable session id
 * in `x-opencode-session` for each conversation (https://opencode.ai/docs/go/).
 * Without it the endpoint answers 400 MissingSessionID. Only added for Go.
 */
export function goHeaders(sessionId: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': CLIENT_USER_AGENT };
  if (sessionId) headers['x-opencode-session'] = sessionId;
  return headers;
}

export async function createProviderHandle(config: Config): Promise<ProviderHandle> {
  if (config.provider === 'opencode-local') {
    return createLocalHandle(config);
  }
  const key = await resolveApiKey(config.baseUrl);

  const models = createModels({
    authContext: {
      env: async (name: string) => (name === 'OPENCODE_API_KEY' ? key : undefined),
      fileExists: async () => false,
    },
  });

  const provider = createProvider({
    id: config.provider,
    name: config.provider,
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth('API key', ['OPENCODE_API_KEY']) },
    models: [
      {
        id: config.model,
        name: config.model,

        api: 'openai-completions',
        provider: config.provider,
        baseUrl: config.baseUrl,
        // Google rechaza el campo `store` con 400 ("Unknown name store") y la
        // autodeteccion de pi-ai no conoce ese endpoint: sin override manda
        // store:false y toda llamada falla. Verificado con llamada real
        // (400 con store, 200 sin el).
        ...(isGoogleEndpoint(config.baseUrl) ? { compat: { supportsStore: false } } : {}),
        // Image input is not optional here: computer use is the whole point.
        input: ['text', 'image'],
        reasoning: false,
        contextWindow: config.contextWindowTokens,
        maxTokens: config.maxOutputTokens,
        // Unknown cost, not zero cost. See docs note: budget code must not treat 0 as free.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      // Quota fallback (P2-17): same endpoint, same auth, same capabilities as
      // the primary; only the model id changes. Registered here because pi-ai's
      // catalog does not know this provider's models.
      ...(config.fallbackModel
        ? [
            {
              id: config.fallbackModel,
              name: config.fallbackModel,
              api: 'openai-completions' as const,
              provider: config.provider,
              baseUrl: config.baseUrl,
              ...(isGoogleEndpoint(config.baseUrl) ? { compat: { supportsStore: false } } : {}),
              input: ['text', 'image'] as Array<'text' | 'image'>,
              reasoning: false,
              contextWindow: config.contextWindowTokens,
              maxTokens: config.maxOutputTokens,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ]
        : []),
    ],
    api: { 'openai-completions': openAICompletionsApi() },
  });

  models.setProvider(provider);
  const model = models.getModel(config.provider, config.model);
  if (!model) {
    throw new Error(`model ${config.provider}/${config.model} not registered`);
  }
  const go = isOpenCodeEndpoint(config.baseUrl);
  // Go needs its client + session headers on whatever model is being streamed,
  // including a fallback the agent swapped in mid-run. Wrapping the passed
  // model (instead of always the primary) is what makes the fallback effective
  // on Go endpoints; for the primary the result is identical to the old
  // override, since initialState.model carries no headers.
  const withGoHeaders = (m: Model<string>, sessionId?: string): Model<string> =>
    go ? ({ ...m, headers: { ...m.headers, ...goHeaders(sessionId) } } as Model<string>) : m;
  const modelFor = (sessionId?: string): Model<string> => withGoHeaders(model, sessionId);
  // Gemini 3.x: devolver extra_content.google.thought_signature de cada tool
  // call (si no, HTTP 400 tras la primera herramienta). Solo endpoints Google.
  const signatureFetch = isGoogleEndpoint(config.baseUrl)
    ? createGeminiSignatureFetch()
    : undefined;
  const streamFn: ProviderHandle['streamFn'] = (m, context, options) =>
    models.streamSimple(
      withGoHeaders(m, options?.sessionId),
      context,
      signatureFetch && !options?.fetch ? { ...options, fetch: signatureFetch } : options,
    );
  const fallback = config.fallbackModel
    ? models.getModel(config.provider, config.fallbackModel)
    : undefined;
  if (config.fallbackModel && !fallback) {
    throw new Error(`fallback model ${config.provider}/${config.fallbackModel} not registered`);
  }
  const fallbackFor = fallback
    ? (sessionId?: string): Model<string> => withGoHeaders(fallback, sessionId)
    : undefined;
  log.info('provider ready', {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
  });
  return { models, model, streamFn, modelFor, fallbackFor };
}

async function resolveApiKey(baseUrl: string): Promise<string> {
  if (isOpenRouterEndpoint(baseUrl)) {
    // Nunca la clave de OpenCode contra OpenRouter: seria un 401 y una fuga
    // del secreto a un tercero. Solo vault provider:openrouterKey o
    // OPENROUTER_API_KEY, con error claro si falta.
    const fromVault = await vaultGet('provider:openrouterKey');
    if (fromVault) return fromVault;
    const fromEnv = process.env.OPENROUTER_API_KEY;
    if (fromEnv) return fromEnv;
    throw new Error(
      'no OpenRouter API key: run `pa vault set provider:openrouterKey <key>` or set OPENROUTER_API_KEY',
    );
  }
  if (isGoogleEndpoint(baseUrl)) {
    // Gemini: nunca la clave de OpenCode. Vault provider:geminiKey o
    // GEMINI_API_KEY/GOOGLE_API_KEY, con error claro si falta.
    const fromVault = await vaultGet('provider:geminiKey');
    if (fromVault) return fromVault;
    const fromEnv = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (fromEnv) return fromEnv;
    throw new Error(
      'no Gemini API key: run `pa vault set provider:geminiKey <key>` or set GEMINI_API_KEY',
    );
  }
  if (!isOpenCodeEndpoint(baseUrl)) {
    // Endpoint OpenAI-compatible custom (Cerebras, vLLM, ...): NUNCA la
    // clave de OpenCode ni vault provider:apiKey - un typo en PA_BASE_URL
    // enviaria el secreto OpenCode a un tercero (hallazgo auditor #103).
    // Falla cerrado si no hay PA_API_KEY explicita.
    if (process.env.PA_API_KEY) return process.env.PA_API_KEY;
    throw new Error(
      `no API key for custom endpoint ${baseUrl}: set PA_API_KEY (the OpenCode key is never sent to third-party endpoints)`,
    );
  }
  const fromVault = await vaultGet('provider:apiKey');
  if (fromVault) return fromVault;
  const fromEnv = process.env.OPENCODE_GO_API_KEY;
  if (fromEnv) return fromEnv;
  throw new Error(
    'no API key: run `pa vault set provider:apiKey <key>` or set OPENCODE_GO_API_KEY',
  );
}

/** True para el preset opencode-local (serve local en la maquina del usuario). */
export function isOpenCodeLocalProvider(provider: string): boolean {
  return provider === 'opencode-local';
}

/**
 * Handle para `opencode serve` local: sin key aqui (la guarda el propio serve),
 * streamFn va al cliente local y completeSimple (resumenes y extraccion de
 * hechos) se rutea por el mismo stream porque serve NO habla OpenAI
 * chat-completions (medido: su API es de sesiones).
 */
async function createLocalHandle(config: Config): Promise<ProviderHandle> {
  const stream = createOpenCodeLocalStream({
    url: config.baseUrl,
    model: config.model,
    variant: config.variant,
    ...DEFAULT_OPENCODE_LOCAL,
  });
  const models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const provider = createProvider({
    id: config.provider,
    name: config.provider,
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth('API key', ['OPENCODE_API_KEY']) },
    models: [
      {
        id: config.model,
        name: config.model,
        api: 'openai-completions',
        provider: config.provider,
        baseUrl: config.baseUrl,
        input: ['text', 'image'],
        reasoning: false,
        contextWindow: config.contextWindowTokens,
        maxTokens: config.maxOutputTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      // Quota fallback (P2-17): the local serve exposes the -free siblings on
      // the same endpoint and auth, so the fallback is the same entry with a
      // different id. Without this registration the opencode-local preset -
      // the one with a default fallback - had none (auditor #162).
      ...(config.fallbackModel
        ? [
            {
              id: config.fallbackModel,
              name: config.fallbackModel,
              api: 'openai-completions' as const,
              provider: config.provider,
              baseUrl: config.baseUrl,
              input: ['text', 'image'] as Array<'text' | 'image'>,
              reasoning: false,
              contextWindow: config.contextWindowTokens,
              maxTokens: config.maxOutputTokens,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ]
        : []),
    ],
    api: { 'openai-completions': openAICompletionsApi() },
  });
  models.setProvider(provider);
  const model = models.getModel(config.provider, config.model);
  if (!model) {
    throw new Error(`model ${config.provider}/${config.model} not registered`);
  }
  const localFallback = config.fallbackModel
    ? models.getModel(config.provider, config.fallbackModel)
    : undefined;
  if (config.fallbackModel && !localFallback) {
    throw new Error(`fallback model ${config.provider}/${config.fallbackModel} not registered`);
  }
  // Los resumenes y la extraccion de hechos llaman a models.completeSimple con
  // un Context simple: lo normalizamos y lo mandamos por el stream local.
  const originalComplete = models.completeSimple.bind(models);
  models.completeSimple = (async (
    m: Model<string>,
    ctx: Parameters<typeof originalComplete>[1],
    opts?: Parameters<typeof originalComplete>[2],
  ) => {
    if ((m as Model<string>).provider !== config.provider) return originalComplete(m, ctx, opts);
    const normalized = normalizeContext(ctx as never);
    const result = await stream(
      m as Model<'openai-completions'>,
      normalized,
      opts as never,
    ).result();
    return result as never;
  }) as typeof models.completeSimple;
  log.info('provider ready (opencode-local)', {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
  });
  return {
    models,
    model,
    streamFn: (m, context, options) =>
      stream(m as Model<'openai-completions'>, context as never, options),
    modelFor: () => model,
    // No Go headers here: the local endpoint is never an OpenCode endpoint.
    fallbackFor: localFallback ? () => localFallback : undefined,
  };
}
