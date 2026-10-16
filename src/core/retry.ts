/**
 * Transient-failure detection for the model provider.
 *
 * `space-bunny-free` on OpenCode Zen fails intermittently with error bodies that
 * read as terminal — `400 invalid_request`, `500 Endpoint is unavailable` — and the
 * byte-identical request succeeds on the next attempt. pi's own retry logic keys off
 * transport errors, so these need re-asking explicitly.
 *
 * The danger is mistaking a *real* error for a flaky one and looping forever, so
 * the classifier is deliberately conservative: it matches on specific known-flaky
 * text, and anything unrecognised is treated as permanent.
 */
const FLAKY_MARKERS = [
  /upstream request failed/i,
  /endpoint is unavailable/i,
  /invalid request/i,
  /freed?tiererror/i,
  /model access is disabled/i,
  /overloaded/i,
  /rate limit/i,
  // Quota exhaustion must enter the retry loop so the loop can FALL BACK to the
  // secondary model (isQuotaError decides the swap). Without this marker a bare
  // "daily quota exhausted" was neither retried nor fallen back (auditor #162).
  /quota/i,
  /\b(429|500|502|503|504)\b/,
  /timeout/i,
  /timed out/i,
  /socket hang up/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
];

/** Reasons that must never be retried, whatever else the message says. */
const PERMANENT_MARKERS = [
  /context length|too many tokens|maximum context/i,
  /invalid api key|unauthorized|401/i,
  /insufficient funds|402/i,
  /model not found|404/i,
  /content filter/i,
];

export function isTransientProviderError(message: string | null | undefined): boolean {
  if (!message) return false;
  if (PERMANENT_MARKERS.some((p) => p.test(message))) return false;
  return FLAKY_MARKERS.some((p) => p.test(message));
}

/**
 * Quota/rate-limit failures: the subset of transient errors where retrying the
 * SAME model is the wrong move - the free tier is exhausted and the next call
 * fails the same way. A REAL subset of isTransientProviderError (every marker
 * here is also a flaky marker), so a quota error always enters the retry loop
 * first and the loop decides the swap. Timeouts and 5xx stay same-model
 * retries (the provider hiccuped, the quota is fine). PERMANENT_MARKERS still
 * win: a 402 with "quota" in the text is a billing error, not a free-tier
 * hiccup.
 */
const QUOTA_MARKERS = [/\b429\b/, /rate limit/i, /quota/i, /freed?tiererror/i];

export function isQuotaError(message: string | null | undefined): boolean {
  if (!message) return false;
  if (PERMANENT_MARKERS.some((p) => p.test(message))) return false;
  return QUOTA_MARKERS.some((p) => p.test(message));
}

/**
 * Which model a run falls back to when the primary's quota dies. The env value
 * always wins; without it only the opencode-local preset gets a default - its
 * local `opencode serve` is verified to expose space-bunny-free on the same
 * endpoint and auth (see src/core/opencode-local.ts), so the swap costs
 * nothing and leaks nothing. Other presets get no silent fallback: pointing a
 * fallback at an endpoint that never registered it would fail louder than the
 * original error. A fallback equal to the primary is no fallback.
 */
export function pickFallbackModel(
  preset: string,
  envValue: string | undefined,
  primaryModel: string,
): string | undefined {
  const candidate = envValue ?? (preset === 'opencode-local' ? 'space-bunny-free' : undefined);
  if (!candidate || candidate === primaryModel) return undefined;
  return candidate;
}

export interface RetryPolicy {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, baseDelayMs: 1_500, maxDelayMs: 20_000 };

/** Full jitter: a fixed backoff synchronises every client against the same provider. */
export function retryDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
