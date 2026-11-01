import { describe, expect, it } from 'vitest';
import { kindleSendFailLine } from '../src/tools/book.js';

describe('Kindle: fallo al enviar por correo en castellano llano', () => {
  it.each([
    [
      '535-5.7.8 Username and Password not accepted. Learn more at https://support.google.com',
      'contraseña de aplicación',
    ],
    ['connect ETIMEDOUT 142.250.0.1:465', 'no hay conexión'],
    ["552-5.3.4 Your message exceeded Google's message size limits", 'pesa demasiado'],
    ['Error: something odd happened in nodemailer', 'no lo aceptó'],
  ])('%s', (raw, plain) => {
    const line = kindleSendFailLine(raw);
    expect(line).toContain('No he podido enviarlo por correo');
    expect(line).toContain(plain);
    expect(line).not.toMatch(
      /535|ETIMEDOUT|552|Error|nodemailer|support\.google|\d+\.\d+\.\d+\.\d+/,
    );
  });
});
