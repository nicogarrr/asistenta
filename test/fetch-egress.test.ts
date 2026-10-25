import { describe, expect, it } from 'vitest';
import { isHostAllowed, parseAllowedHosts } from '../src/tools/fetch.js';

// Egress allowlist: sin lista, fetch sigue libre (comportamiento anterior); con
// PA_FETCH_ALLOWED_HOSTS puesta, solo esos hosts y sus subdominios, nunca un
// "example.com.evil.example" que solo contiene el nombre.
describe('allowlist de egress de fetch', () => {
  it('parsea la lista separada por comas', () => {
    expect(parseAllowedHosts(' Example.com, foo.bar ,, ')).toEqual(['example.com', 'foo.bar']);
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts('')).toEqual([]);
  });

  it('sin lista no restringe', () => {
    expect(isHostAllowed('cualquier.cosa', [])).toBe(true);
  });

  it('permite el host y sus subdominios', () => {
    expect(isHostAllowed('example.com', ['example.com'])).toBe(true);
    expect(isHostAllowed('api.example.com', ['example.com'])).toBe(true);
    expect(isHostAllowed('EXAMPLE.COM.', ['example.com'])).toBe(true);
  });

  it('no confunde un nombre que solo contiene el dominio', () => {
    expect(isHostAllowed('example.com.evil.example', ['example.com'])).toBe(false);
    expect(isHostAllowed('notexample.com', ['example.com'])).toBe(false);
  });
});
