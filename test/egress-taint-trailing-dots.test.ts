import { describe, expect, it } from 'vitest';
import { egressHost, taintSourceOfPage } from '../src/egress-taint.js';

// Un nombre con puntos finales es el mismo host para DNS: una web privada
// («mail.google.com..») debe seguir contando como lectura privada.
describe('egress-taint: hosts con puntos finales', () => {
  it('taintSourceOfPage reconoce una web privada con uno o varios puntos finales', () => {
    expect(taintSourceOfPage('https://mail.google.com/')).not.toBeNull();
    expect(taintSourceOfPage('https://mail.google.com./')).not.toBeNull();
    expect(taintSourceOfPage('https://mail.google.com../')).not.toBeNull();
    expect(taintSourceOfPage('https://MAIL.Google.com.../u/0')).not.toBeNull();
  });
  it('una web pública sigue sin marcar', () => {
    expect(taintSourceOfPage('https://example.com../')).toBeNull();
  });
  it('egressHost no cambia', () => {
    expect(egressHost('https://Example.COM../x')).toBe('example.com');
    expect(egressHost('no es url')).toBeNull();
  });
});
