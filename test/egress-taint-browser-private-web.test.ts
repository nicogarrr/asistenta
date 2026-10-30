import { describe, expect, it } from 'vitest';
import { taintSourceOf } from '../src/egress-taint.js';

// El navegador usa el perfil de Nico con la sesión iniciada: abrir Gmail, Drive o
// WhatsApp Web mete contenido privado en el turno igual que leer un archivo.
describe('browser en webs con sesión iniciada', () => {
  it.each([
    'https://mail.google.com/mail/u/0/#inbox',
    'https://docs.google.com/document/d/abc/edit',
    'https://web.whatsapp.com/',
    'https://outlook.office.com/mail/',
    'https://www.icloud.com/mail',
    'https://MAIL.GOOGLE.COM./x',
  ])('%s cuenta como lectura privada', (url) => {
    expect(taintSourceOf('browser', { action: 'open', url })).toMatch(/sesión iniciada/);
  });

  it.each([
    'https://www.google.com/search?q=tiempo',
    'https://es.wikipedia.org/wiki/Madrid',
    'https://notgoogle.com.evil/mail.google.com',
    'https://mail.google.com.evil.net/',
  ])('%s sigue sin contaminar (sin cambio)', (url) => {
    expect(taintSourceOf('browser', { action: 'open', url })).toBeNull();
  });

  it('un browser sin URL sigue sin contaminar', () => {
    expect(taintSourceOf('browser', { action: 'click', selector: '#b' })).toBeNull();
  });
});
