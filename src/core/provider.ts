import type { Model, MutableModels } from '@earendil-works/pi-ai';
import { createModels, envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { createProvider } from '@earendil-works/pi-ai/models';
import type { Config } from '../config.js';
import { log } from '../log.js';
import { vaultGet } from '../vault.js';

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
  const key = await resolveApiKey();

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
        // Image input is not optional here: computer use is the whole point.
        input: ['text', 'image'],
        reasoning: false,
        contextWindow: 1_048_576,
        maxTokens: 32_000,
        // Unknown cost, not zero cost. See docs note: budget code must not treat 0 as free.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    api: { 'openai-completions': openAICompletionsApi() },
  });

  models.setProvider(provider);
  const model = models.getModel(config.provider, config.model);
  if (!model) {
    throw new Error(`model ${config.provider}/${config.model} not registered`);
  }
  const go = isOpenCodeEndpoint(config.baseUrl);
  const modelFor = (sessionId?: string): Model<string> =>
    go
      ? ({ ...model, headers: { ...model.headers, ...goHeaders(sessionId) } } as Model<string>)
      : model;
  const streamFn: ProviderHandle['streamFn'] = (m, context, options) =>
    models.streamSimple(go ? modelFor(options?.sessionId) : m, context, options);
  log.info('provider ready', {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
  });
  return { models, model, streamFn, modelFor };
}

async function resolveApiKey(): Promise<string> {
  const fromVault = await vaultGet('provider:apiKey');
  if (fromVault) return fromVault;
  const fromEnv = process.env.OPENCODE_GO_API_KEY;
  if (fromEnv) return fromEnv;
  throw new Error(
    'no API key: run `pa vault set provider:apiKey <key>` or set OPENCODE_GO_API_KEY',
  );
}
