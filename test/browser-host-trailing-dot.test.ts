import { describe, expect, it } from 'vitest';
import { domainCovers, hostOf } from '../src/browser/service.js';

describe('host with a trailing dot is the same host', () => {
  it('hostOf drops the trailing dot of a fully qualified name', () => {
    expect(hostOf('https://paypal.com./signin')).toBe('paypal.com');
    expect(hostOf('https://www.paypal.com./')).toBe('paypal.com');
    expect(hostOf('https://paypal.com%2e/')).toBe('paypal.com');
  });

  it('a never-approve or approved domain still covers the dotted form', () => {
    expect(domainCovers('paypal.com', hostOf('https://paypal.com./') ?? '')).toBe(true);
    expect(domainCovers('paypal.com', 'checkout.paypal.com.')).toBe(true);
    expect(domainCovers('renfe.com.', 'renfe.com')).toBe(true);
    expect(domainCovers('renfe.com', 'renfe.com.evil.net.')).toBe(false);
  });
});
