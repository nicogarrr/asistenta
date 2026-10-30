import { pickFallbackModel, type RetryPolicy } from './core/retry.js';
import { COOKIE_BROWSERS } from './media/cookie-browsers.js';

export type BrowserChannel = 'chrome' | 'msedge' | 'chromium';

/**
 * Configuration is env-only and validated once, at startup, in `loadConfig()`.
 *
 * Nothing else in the codebase reads `process.env` for behaviour: the whole point
 * is that a value is either declared here or it does not exist. Secrets are NOT
 * here — those live in the vault (see vault.ts) and are fetched at point of use.
 */
export interface Config {
  /** Named provider preset: 'opencode' (default) or 'openrouter'. */
  providerPreset?: string;
  /** Provider id, matching the id in the pi-ai provider registry. */
  provider: string;
  model: string;
  /**
   * Secondary model for one run when the primary's quota dies (see
   * isQuotaError/pickFallbackModel). Same endpoint, same auth; undefined on
   * presets whose endpoint never registered a second model.
   */
  fallbackModel?: string;
  /** PA_MODELS: otros modelos (separados por comas) que /modelo puede elegir. */
  extraModels?: string[];
  baseUrl: string;
  variant?: string | undefined;
  /** Wall-clock ceiling for a single tool call. */
  toolTimeoutMs: number;
  /** Hard ceiling on one agent run, so a runaway loop cannot pin the daemon. */
  runTimeoutMs: number;
  /**
   * Silence ceiling inside a run. If no token, tool start, or tool end arrives for
   * this long, the stream is assumed hung and the run is aborted (then retried as a
   * transient failure). Long tools are fine: starting one resets the clock.
   */
  idleTimeoutMs: number;
  /** Screenshot max edge in px before the model sees it; bounds token cost. */
  screenshotMaxEdge: number;
  /** JPEG quality for screenshots. 70-85 keeps small UI text legible. */
  screenshotQuality: number;
  /**
   * Diff the screen before and after every input action and report whether anything
   * changed. It costs two extra screenshots per action (roughly +400ms on Windows)
   * and no tokens, and it removes the single most common failure in GUI work: a click
   * that did nothing, followed by the same click again because nothing said otherwise.
   */
  verifyActions: boolean;
  /**
   * Kill switch for Computer Use (`PA_COMPUTER_USE=0`): every `computer` action,
   * screenshots included, is refused before touching the desktop. On by default.
   */
  computerUse?: boolean;
  /** How long to wait after an action before comparing frames. Windows animations land in ~250ms. */
  verifySettleMs: number;
  /** Cron jobs from PA_CRON, newline separated `schedule<TAB>prompt`. */
  cron: Array<{ schedule: string; prompt: string }>;
  /** Retry budget for transient provider failures, per turn. */
  retry: RetryPolicy;
  /**
   * Hard ceiling on tool calls per run. A run that needs more than this is not
   * making progress, it is exploring; stop it and report instead of billing more.
   */
  maxToolCalls: number;
  /** Ventana de contexto real del modelo (PA_CONTEXT_WINDOW). Se usa para
   *  estimar el prompt y para el fallback de compactación por desbordamiento. */
  contextWindowTokens: number;
  /** Tope de tokens de salida por respuesta (PA_MAX_OUTPUT_TOKENS). */
  maxOutputTokens: number;
  /**
   * Tope de gasto diario en EUR (PA_DAILY_BUDGET_EUR). 0 o ausente = sin
   * limite, que es el default: los presets actuales son modelos free. Se
   * comprueba contra el JSONL de uso del dia (src/core/usage.ts).
   */
  dailyBudgetEur: number;
  /**
   * Which browser the `browser` tool drives. 'chrome' / 'msedge' use the one installed on
   * this PC (a real fingerprint, far fewer anti-bot walls); 'chromium' is the copy bundled
   * with Playwright. If the chosen one is not installed the tool falls back to 'chromium'.
   */
  browserChannel: BrowserChannel;
  /** Browser whose cookies yt-dlp may use (`firefox`, `chrome`...). Empty = off. */
  downloadCookiesBrowser: string;
  /** Path to curl-impersonate for PDFs behind anti-bot walls. Empty = look on PATH. */
  curlImpersonatePath: string;
  /**
   * Tope de coste por llamada del enrutador web (src/web/router.ts), en EUR.
   * Por defecto 0: solo backends gratis; un backend con coste nunca se llama.
   */
  webMaxCostEur: number;
  /**
   * Motor de la palabra de activacion: 'whisper' (defecto; transcribe cada
   * ventana de 3s y compara texto) u 'oww' (runner openWakeWord dedicado:
   * score ONNX por frame de 80ms, ~1-2s de CPU menos por chequeo). Detras de
   * flag porque la comparacion FAR/FRR contra whisper aun no esta medida en
   * el PC de Nico (A1b); la ruta de entrenamiento del modelo esta en
   * docs/wakeword-oww.md.
   */
  voiceWake: {
    engine: 'whisper' | 'oww';
    /**
     * Nombre simple .onnx del modelo de palabra dentro de paths.models/oww,
     * entrenado con scripts/wakeword-train.py. Requerido con engine 'oww'.
     */
    owwModel: string;
    /** Umbral de score del clasificador oww (0..1). Por defecto 0.5. */
    owwThreshold: number;
  };
}

/** Env var restricted to a fixed set of values. A typo is an error, not a silent default. */
function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  const hit = allowed.find((a) => a === raw);
  if (!hit)
    throw new Error(`${name} must be one of ${allowed.join(', ')}, got ${JSON.stringify(raw)}`);
  return hit;
}

/**
 * Texto opcional. Vacío o solo espacios cuenta como «no definido», igual que en
 * num/flag/oneOf: una línea `PA_MODEL=` en el .env no puede dejar el modelo en ''.
 */
function str(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? raw : undefined;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  // Todos los num() son cuentas, milisegundos o tokens: un «2.5» daba 2,5 intentos
  // (el bucle hacía 3) o un timeout fraccionario. Se rechaza igual que «abc».
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Numero >= 0: 0 es un valor valido (p. ej. presupuesto diario desactivado). */
function nonNegativeNum(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a number >= 0, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * Boolean env var. Only an explicit falsey value turns it off, so a typo leaves the
 * safer default in place instead of silently disabling a safety feature.
 *
 * Exported for the config tests, which assert that property directly: the whole point
 * of the function is that a misspelled variable name cannot quietly disable something.
 */
export function flag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

function parseCron(raw: string | undefined): Array<{ schedule: string; prompt: string }> {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      if (tab < 0) {
        throw new Error(`PA_CRON entry must be "schedule<TAB>prompt", got ${JSON.stringify(line)}`);
      }
      return { schedule: line.slice(0, tab).trim(), prompt: line.slice(tab + 1).trim() };
    });
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const cron = parseCron(process.env.PA_CRON);
  for (const job of cron) {
    const fields = job.schedule.split(/\s+/);
    // Deliberately accepts 5-field cron and 6-field with seconds, since both show
    // up in the wild. Validation is shape-only; the scheduler decides the rest.
    if (fields.length !== 5 && fields.length !== 6) {
      throw new Error(
        `PA_CRON schedule must have 5 or 6 fields, got ${JSON.stringify(job.schedule)}`,
      );
    }
  }
  // Preset de proveedor: OpenCode Zen free es el default; 'openrouter' conmuta
  // todos los defaults a OpenRouter (PA_PROVIDER/PA_MODEL/PA_BASE_URL siguen
  // pudiendo anular cada valor por encima del preset elegido).
  const providerPreset = str('PA_PROVIDER_PRESET')?.toLowerCase() ?? 'opencode';
  if (!['opencode', 'openrouter', 'opencode-local'].includes(providerPreset)) {
    throw new Error(
      `PA_PROVIDER_PRESET must be 'opencode', 'openrouter' or 'opencode-local', got ${JSON.stringify(providerPreset)}`,
    );
  }
  const presetDefaults =
    providerPreset === 'openrouter'
      ? {
          provider: 'openrouter',
          model: 'thinkingmachines/inkling-small:free',
          baseUrl: 'https://openrouter.ai/api/v1',
          variant: undefined as string | undefined,
        }
      : providerPreset === 'opencode-local'
        ? {
            // `opencode serve` local (ver src/core/opencode-local.ts): la unica
            // via legitima para los modelos -free de Zen desde asistenta.
            provider: 'opencode-local',
            model: 'deepseek-v4.1-flash-free',
            baseUrl: 'http://127.0.0.1:4096',
            // Modo max: el serve expone variants low|high|max para este modelo
            // (verificado 2026-10-16 contra /provider en vivo: ~7x mas reasoning).
            variant: 'max' as string | undefined,
          }
        : {
            provider: 'opencode-go',
            model: 'space-bunny-free',
            baseUrl: 'https://opencode.ai/zen/v1',
            variant: undefined as string | undefined,
          };
  cached = {
    providerPreset,
    provider: str('PA_PROVIDER') ?? presetDefaults.provider,
    model: str('PA_MODEL') ?? presetDefaults.model,
    fallbackModel: pickFallbackModel(
      providerPreset,
      process.env.PA_FALLBACK_MODEL,
      str('PA_MODEL') ?? presetDefaults.model,
    ),
    extraModels: parseModelList(process.env.PA_MODELS),
    baseUrl: str('PA_BASE_URL') ?? presetDefaults.baseUrl,
    variant: process.env.PA_MODEL_VARIANT ?? presetDefaults.variant,
    contextWindowTokens: num('PA_CONTEXT_WINDOW', 1_048_576),
    maxOutputTokens: num('PA_MAX_OUTPUT_TOKENS', 32_000),
    dailyBudgetEur: nonNegativeNum('PA_DAILY_BUDGET_EUR', 0),
    toolTimeoutMs: num('PA_TOOL_TIMEOUT_MS', 120_000),
    runTimeoutMs: num('PA_RUN_TIMEOUT_MS', 900_000),
    idleTimeoutMs: num('PA_IDLE_TIMEOUT_MS', 180_000),
    screenshotMaxEdge: num('PA_SCREENSHOT_MAX_EDGE', 1280),
    screenshotQuality: num('PA_SCREENSHOT_QUALITY', 80),
    // `flag` rather than `num` because this is a switch, and a value of 0 must mean
    // "off" instead of "invalid".
    verifyActions: flag('PA_VERIFY_ACTIONS', true),
    computerUse: flag('PA_COMPUTER_USE', true),
    verifySettleMs: num('PA_VERIFY_SETTLE_MS', 350),
    cron,
    retry: {
      // Three tries with full jitter. More than that turns a genuinely broken
      // provider into a slow hang without making a flaky one succeed.
      attempts: num('PA_RETRY_ATTEMPTS', 3),
      baseDelayMs: num('PA_RETRY_BASE_MS', 1_500),
      maxDelayMs: num('PA_RETRY_MAX_MS', 20_000),
    },
    maxToolCalls: num('PA_MAX_TOOL_CALLS', 60),
    browserChannel: oneOf<BrowserChannel>(
      'PA_BROWSER_CHANNEL',
      ['chrome', 'msedge', 'chromium'],
      'chrome',
    ),
    // Off by default: it hands the browser's logged-in cookies to yt-dlp.
    downloadCookiesBrowser: oneOf<string>(
      'PA_DOWNLOAD_COOKIES_BROWSER',
      ['', ...COOKIE_BROWSERS],
      '',
    ),
    curlImpersonatePath: process.env.PA_CURL_IMPERSONATE?.trim() ?? '',
    webMaxCostEur: (() => {
      const raw = process.env.PA_WEB_MAX_COST_EUR;
      if (!raw) return 0;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`PA_WEB_MAX_COST_EUR must be a number >= 0, got ${JSON.stringify(raw)}`);
      }
      return parsed;
    })(),
    voiceWake: (() => {
      const engine = oneOf<'whisper' | 'oww'>('PA_WAKE_ENGINE', ['whisper', 'oww'], 'whisper');
      const owwModel = process.env.PA_WAKE_OWW_MODEL?.trim() ?? '';
      // Un nombre simple: el valor acaba como nombre de fichero dentro del
      // dir de modelos; rutas o '..' aqui serian una escritura fuera de el.
      if (engine === 'oww' && (!/^[\w.-]+\.onnx$/.test(owwModel) || owwModel.includes('..'))) {
        throw new Error(
          `PA_WAKE_OWW_MODEL must be a plain .onnx file name trained with scripts/wakeword-train.py (see docs/wakeword-oww.md), got ${JSON.stringify(owwModel)}`,
        );
      }
      const rawThreshold = process.env.PA_WAKE_OWW_THRESHOLD;
      let owwThreshold = 0.5;
      if (rawThreshold) {
        const parsed = Number(rawThreshold);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
          throw new Error(
            `PA_WAKE_OWW_THRESHOLD must be a number between 0 and 1, got ${JSON.stringify(rawThreshold)}`,
          );
        }
        owwThreshold = parsed;
      }
      return { engine, owwModel, owwThreshold };
    })(),
  };
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}

/** PA_MODELS: lista separada por comas (o espacios), sin vacíos ni repetidos, máx. 8. */
export function parseModelList(raw: string | undefined): string[] {
  const ids = (raw ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return [...new Set(ids)].slice(0, 8);
}
