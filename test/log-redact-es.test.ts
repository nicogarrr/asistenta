import { describe, expect, it } from 'vitest';
import { redact, scrubLogText } from '../src/log.js';

describe('registro: credenciales con nombre en castellano', () => {
  it('campos contraseña, clave, passwd, pin… se tapan', () => {
    const out = redact({
      contraseña: 'Hunter2!',
      contrasena: 'x1',
      clave: 'k1',
      claveApi: 'k2',
      passwd: 'p1',
      pwd: 'p2',
      passphrase: 'p3',
      pass: 'p4',
      pin: '1234',
      otp: '987654',
      cuenta: { usuario: 'nico', contraseña: 'anidada' },
    });
    expect(JSON.stringify(out)).not.toMatch(/Hunter2|x1|k1|k2|p1|p2|p3|p4|1234|987654|anidada/);
    expect((out.cuenta as Record<string, unknown>).usuario).toBe('nico');
  });

  it('nombres que solo contienen esas letras no se tapan', () => {
    expect(redact({ pinned: true, passed: 3, spinner: 'a', otpEnabled: false })).toEqual({
      pinned: true,
      passed: 3,
      spinner: 'a',
      otpEnabled: false,
    });
  });

  it('«contraseña: …» y «clave=…» en texto libre se tapan', () => {
    const t = scrubLogText('login fallido, contraseña: Hunter2! y clave=abc123 (usuario nico)');
    expect(t).not.toContain('Hunter2');
    expect(t).not.toContain('abc123');
    expect(t).toContain('usuario nico');
    expect(scrubLogText('Sin clave, no hay modelo')).toBe('Sin clave, no hay modelo');
  });
});
