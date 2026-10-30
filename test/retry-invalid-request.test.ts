import { describe, expect, it } from 'vitest';
import { isTransientProviderError } from '../src/core/retry.js';

describe('isTransientProviderError: «invalid_request» intermitente', () => {
  it('«400 invalid_request» (guion bajo, el cuerpo real) se reintenta', () => {
    expect(isTransientProviderError('400 invalid_request')).toBe(true);
    expect(isTransientProviderError('{"error":{"type":"invalid_request"}}')).toBe(true);
  });
  it('«invalid request» con espacio sigue reintentándose', () => {
    expect(isTransientProviderError('400 Invalid request')).toBe(true);
  });
  it('un marcador permanente sigue ganando aunque diga invalid_request', () => {
    expect(isTransientProviderError('invalid_request: maximum context length exceeded')).toBe(
      false,
    );
    expect(isTransientProviderError('401 invalid_request: unauthorized')).toBe(false);
  });
});
