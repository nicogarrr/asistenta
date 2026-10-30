import { describe, expect, it } from 'vitest';
import { redact } from '../src/log.js';

describe('redact: nombres de campo', () => {
  it('campos inocentes que contienen key/token/card ya no se tapan', () => {
    const out = redact({
      keyboard: [['Sí', 'No']],
      inputTokens: 1200,
      output_tokens: 80,
      maxTokens: 4096,
      tokenCount: 3,
      discard: true,
      cardinality: 2,
    });
    expect(out).toEqual({
      keyboard: [['Sí', 'No']],
      inputTokens: 1200,
      output_tokens: 80,
      maxTokens: 4096,
      tokenCount: 3,
      discard: true,
      cardinality: 2,
    });
  });

  it('las credenciales siguen tapadas, también anidadas y con nombres parecidos', () => {
    const out = redact({
      token: 'abc',
      apiKey: 'k',
      PA_API_KEY: 'k2',
      botToken: '123',
      accessTokens: ['a'],
      refreshToken: 'r',
      tokens: 'lista',
      keys: ['x'],
      cardNumber: '4111',
      card: { cvv: '123' },
      password: 'p',
      cookie: 'c',
      authorization: 'Bearer x',
      nested: { secretKey: 's', keyboardSecret: 'z' },
    });
    for (const k of [
      'token',
      'apiKey',
      'PA_API_KEY',
      'botToken',
      'accessTokens',
      'refreshToken',
      'tokens',
      'keys',
      'cardNumber',
      'card',
      'password',
      'cookie',
      'authorization',
    ]) {
      expect(out[k], k).toBe('[redacted]');
    }
    expect(out.nested).toEqual({ secretKey: '[redacted]', keyboardSecret: '[redacted]' });
  });
});
