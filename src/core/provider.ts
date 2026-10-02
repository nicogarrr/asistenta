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
  log.info('provider ready', {
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
  });
  return { models, model };
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
