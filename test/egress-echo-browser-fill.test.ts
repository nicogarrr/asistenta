import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';

function gate() {
  const asked: string[] = [];
  const g = new Gate({
    protectedPaths: [],
    allow: ['fetch', 'mail', 'browser'],
    egressTaint: true,
    approver: (_c, reason) => {
      asked.push(reason);
      return true;
    },
  });
  return { g, asked };
}

const MAIL = { tool: 'mail', args: { action: 'read', id: '1' }, actor: 'me' };
const BODY = 'Hola Nico. Te espero en la Calle del Pez 14, portal 3B, a las 19:30. Un abrazo.';

describe('eco del contenido privado en un campo del navegador', () => {
  it('browser fill con un trozo literal del correo leído pregunta', async () => {
    const { g, asked } = gate();
    await g.check('s', MAIL);
    g.settle('s', MAIL, false, BODY);
    await g.check('s', {
      tool: 'browser',
      args: { action: 'fill', selector: '#q', value: 'Calle del Pez 14, portal 3B' },
      actor: 'me',
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/formulario/);
  });

  it('también en base64', async () => {
    const { g, asked } = gate();
    await g.check('s', MAIL);
    g.settle('s', MAIL, false, BODY);
    const b64 = Buffer.from('del Pez 14, portal 3B', 'utf8').toString('base64');
    await g.check('s', {
      tool: 'browser',
      args: { action: 'fill', selector: '#q', value: b64 },
      actor: 'me',
    });
    expect(asked).toHaveLength(1);
  });

  it('un fill sin eco, o sin nada privado leído, no cambia', async () => {
    const { g, asked } = gate();
    await g.check('s', {
      tool: 'browser',
      args: { action: 'fill', selector: '#q', value: 'del Pez 14, portal 3B' },
      actor: 'me',
    });
    expect(asked).toHaveLength(0);
    await g.check('s', MAIL);
    g.settle('s', MAIL, false, BODY);
    await g.check('s', {
      tool: 'browser',
      args: { action: 'fill', selector: '#q', value: 'zapatillas running talla 43' },
      actor: 'me',
    });
    expect(asked).toHaveLength(0);
  });
});
