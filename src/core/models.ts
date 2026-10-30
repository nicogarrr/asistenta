/**
 * Catalogo de capacidades y precios por endpoint/modelo.
 *
 * Los presets solo declaran lo que se ha verificado; cualquier valor puede
 * corregirse por entorno sin tocar codigo. La prioridad es deliberada:
 *
 *   1. variable de entorno (PA_CONTEXT_WINDOW, PA_MAX_OUTPUT_TOKENS,
 *      PA_PRICE_INPUT_PER_MTOK, PA_PRICE_OUTPUT_PER_MTOK)
 *   2. preset del proveedor/modelo
 *   3. defaults conservadores
 *
 * Los precios son EUR por millon de tokens. Un 0 en el catalogo NO significa
 * "gratis garantizado": los presets actuales son modelos free, pero un modelo
 * de pago debe declarar su precio por entorno o quedara subestimado.
 */

/** Presets soportados por config.ts. */
export type ModelPreset = 'opencode' | 'opencode-local' | 'openrouter';

export interface ModelCaps {
  /** Modelo al que pertenecen estas capacidades. */
  id: string;
  /** Ventana total de contexto, en tokens. */
  contextWindow: number;
  /** Tope de tokens de salida por respuesta. */
  maxOutput: number;
  /** EUR por millon de tokens de entrada (incluye lecturas de cache). */
  inputPerMTok: number;
  /** EUR por millon de tokens de salida. */
  outputPerMTok: number;
  supportsImages: boolean;
  reasoning: boolean;
}

/** Lo unico que hace falta de Config para resolver el preset; evita un ciclo de imports. */
export interface ModelConfigLike {
  providerPreset?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  baseUrl?: string | undefined;
}

const OPENCODE_CAPS: ModelCaps = {
  id: 'space-bunny-free',
  contextWindow: 1_048_576,
  maxOutput: 32_000,
  inputPerMTok: 0,
  outputPerMTok: 0,
  supportsImages: true,
  reasoning: false,
};

const OPENCODE_LOCAL_CAPS: ModelCaps = {
  id: 'deepseek-v4.1-flash-free',
  contextWindow: 1_048_576,
  maxOutput: 32_000,
  inputPerMTok: 0,
  outputPerMTok: 0,
  supportsImages: true,
  // El serve local expone variants de razonamiento; el provider actual no las
  // anuncia a pi-ai. Se mantiene false para no cambiar el comportamiento.
  reasoning: false,
};

/**
 * OpenRouter pasa por muchos modelos con ventanas distintas. El preset es
 * generico: conserva los mismos limites que usaba el provider antes de existir
 * el catalogo, y el modelo concreto se ajusta por entorno.
 */
const OPENROUTER_CAPS: ModelCaps = {
  id: 'thinkingmachines/inkling-small:free',
  contextWindow: 1_048_576,
  maxOutput: 32_000,
  inputPerMTok: 0,
  outputPerMTok: 0,
  supportsImages: true,
  reasoning: false,
};

/** Defaults si el preset no existe o el catalogo esta incompleto. */
export const DEFAULT_MODEL_CAPS: ModelCaps = { ...OPENCODE_CAPS, id: 'unknown' };

/**
 * Catalogo por endpoint y modelo. La clave '*' es el fallback del preset:
 * cualquier modelo no listado hereda esas capacidades.
 */
export const MODEL_CATALOG: Readonly<Record<ModelPreset, Readonly<Record<string, ModelCaps>>>> = {
  opencode: {
    [OPENCODE_CAPS.id]: OPENCODE_CAPS,
    '*': OPENCODE_CAPS,
  },
  'opencode-local': {
    [OPENCODE_LOCAL_CAPS.id]: OPENCODE_LOCAL_CAPS,
    '*': OPENCODE_LOCAL_CAPS,
  },
  openrouter: {
    [OPENROUTER_CAPS.id]: OPENROUTER_CAPS,
    '*': OPENROUTER_CAPS,
  },
};

/** Numero de entorno finito; `min` excluye valores absurdos (una ventana de 0). */
function envNumber(name: string, min: number): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) return undefined;
  return parsed;
}

/** Preset efectivo: el explicito manda; si falta se infiere del endpoint/provider. */
function resolvePreset(config: ModelConfigLike): ModelPreset {
  const explicit = config.providerPreset?.trim().toLowerCase();
  if (explicit === 'opencode' || explicit === 'opencode-local' || explicit === 'openrouter') {
    return explicit;
  }
  const provider = config.provider?.trim().toLowerCase() ?? '';
  if (provider === 'openrouter') return 'openrouter';
  if (provider === 'opencode-local') return 'opencode-local';
  if (provider.startsWith('opencode')) return 'opencode';
  const baseUrl = config.baseUrl?.trim().toLowerCase() ?? '';
  if (baseUrl.includes('openrouter.ai')) return 'openrouter';
  if (baseUrl.includes('127.0.0.1:4096') || baseUrl.includes('localhost:4096')) {
    return 'opencode-local';
  }
  return 'opencode';
}

/** Busca un modelo por id exacto en cualquier preset (para uso sin config completa). */
function findModelEntry(model: string): ModelCaps | undefined {
  for (const table of Object.values(MODEL_CATALOG)) {
    const hit = table[model];
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Resuelve contexto, salida, precios y capacidades para un modelo.
 *
 * Acepta un Config completo o solo `{ model }` (usage.ts lo llama asi). Los
 * overrides de entorno se leen en cada llamada, no al importar el modulo: un
 * test o un reinicio del daemon no arrastran valores viejos.
 */
export function resolveModelCaps(config: ModelConfigLike = {}): ModelCaps {
  const preset = resolvePreset(config);
  const requested = config.model?.trim() ?? '';
  const table = MODEL_CATALOG[preset];
  const entry =
    (requested ? table[requested] : undefined) ??
    (requested ? findModelEntry(requested) : undefined) ??
    table['*'] ??
    DEFAULT_MODEL_CAPS;

  const contextWindow = envNumber('PA_CONTEXT_WINDOW', 1) ?? entry.contextWindow;
  const maxOutput = envNumber('PA_MAX_OUTPUT_TOKENS', 1) ?? entry.maxOutput;
  const inputPerMTok = envNumber('PA_PRICE_INPUT_PER_MTOK', 0) ?? entry.inputPerMTok;
  const outputPerMTok = envNumber('PA_PRICE_OUTPUT_PER_MTOK', 0) ?? entry.outputPerMTok;

  return {
    ...entry,
    id: requested || entry.id,
    contextWindow,
    maxOutput,
    inputPerMTok,
    outputPerMTok,
  };
}
