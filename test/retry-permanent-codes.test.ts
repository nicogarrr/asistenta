import { describe, expect, it } from 'vitest';
import { isQuotaError, isTransientProviderError } from '../src/core/retry.js';

// Un id de petición o un timestamp con «401», «402» o «404» dentro no es un código HTTP.
describe('códigos permanentes solo como número completo', () => {
  it('un 503 con un id que contiene 401/402/404 sigue siendo transitorio', () => {
    expect(
      isTransientProviderError('503 Service Unavailable (request id gen-1730401234-abc)'),
    ).toBe(true);
    expect(isTransientProviderError('upstream request failed, trace 98404217')).toBe(true);
    expect(isTransientProviderError('502 Bad Gateway at 17304020')).toBe(true);
  });

  it('un 429 con un número que contiene 401 sigue activando el fallback de cuota', () => {
    expect(isQuotaError('429 rate limit, retry after 14010 ms')).toBe(true);
  });

  it('los códigos reales siguen siendo permanentes', () => {
    expect(isTransientProviderError('401 Unauthorized (503 upstream)')).toBe(false);
    expect(isTransientProviderError('HTTP 402: 500 billing')).toBe(false);
    expect(isTransientProviderError('error 404 from upstream request failed')).toBe(false);
  });
});
