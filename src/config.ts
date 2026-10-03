import type { RetryPolicy } from './core/retry.js';
import { COOKIE_BROWSERS } from './media/cookie-browsers.js';

/**
 * Configuration is env-only and validated once, at startup, in `loadConfig()`.
 *
 * Nothing else in the codebase reads `process.env` for behaviour: the whole point
 * is that a value is either declared here or it does not exist. Secrets are NOT
 * here — those live in the vault (see vault.ts) and are fetched at point of use.
 */
export interface Config {
  /** Provider id, matching the id in the pi-ai provider registry. */
  provider: string;
  model: string;
  baseUrl: string;
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
  /** Browser whose cookies yt-dlp may use (`firefox`, `chrome`...). Empty = off. */
  downloadCookiesBrowser: string;
  /** Path to curl-impersonate for PDFs behind anti-bot walls. Empty = look on PATH. */
  curlImpersonatePath: string;
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

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
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
  cached = {
    provider: process.env.PA_PROVIDER ?? 'opencode-go',
    model: process.env.PA_MODEL ?? 'space-bunny-free',
    baseUrl: process.env.PA_BASE_URL ?? 'https://opencode.ai/zen/v1',
    toolTimeoutMs: num('PA_TOOL_TIMEOUT_MS', 120_000),
    runTimeoutMs: num('PA_RUN_TIMEOUT_MS', 900_000),
    idleTimeoutMs: num('PA_IDLE_TIMEOUT_MS', 180_000),
    screenshotMaxEdge: num('PA_SCREENSHOT_MAX_EDGE', 1280),
    screenshotQuality: num('PA_SCREENSHOT_QUALITY', 80),
    // `flag` rather than `num` because this is a switch, and a value of 0 must mean
    // "off" instead of "invalid".
    verifyActions: flag('PA_VERIFY_ACTIONS', true),
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
    // Off by default: it hands the browser's logged-in cookies to yt-dlp.
    downloadCookiesBrowser: oneOf<string>(
      'PA_DOWNLOAD_COOKIES_BROWSER',
      ['', ...COOKIE_BROWSERS],
      '',
    ),
    curlImpersonatePath: process.env.PA_CURL_IMPERSONATE?.trim() ?? '',
  };
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}
