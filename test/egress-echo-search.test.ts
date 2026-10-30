import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';

function gate() {
  const asked: string[] = [];
  const g = new Gate({
    protectedPaths: [],
    allow: ['mail', 'web', 'checkout', 'book'],
    egressTaint: true,
    approver: (_c, reason) => {
      asked.push(reason);
      return true;
    },
  });
  return { g, asked };
}

const MAIL = { tool: 'mail', args: { action: 'read', id: '1' }, actor: 'me' };
const BODY = 'Hola Nico. Tu código de acceso es K7Q2-ZX91-PLM4 y caduca mañana. Un abrazo.';

describe('eco del contenido privado en una búsqueda', () => {
  it('una búsqueda web con un trozo literal del correo leído pregunta', async () => {
    const { g, asked } = gate();
    await g.check('s', MAIL);
    g.settle('s', MAIL, false, BODY);
    await g.check('s', {
      tool: 'web',
      args: { action: 'search', query: 'código K7Q2-ZX91-PLM4' },
      actor: 'me',
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/búsqueda/);
  });

  it('también en la tienda y en libros', async () => {
    const { g, asked } = gate();
    await g.check('s', MAIL);
    g.settle('s', MAIL, false, BODY);
    await g.check('s', {
      tool: 'checkout',
      args: { action: 'search', query: 'K7Q2-ZX91-PLM4', selector: '#q' },
      actor: 'me',
    });
    await g.check('s', {
      tool: 'book',
      args: { action: 'search', query: 'acceso es K7Q2-ZX91' },
      actor: 'me',
    });
    expect(asked).toHaveLength(2);
  });

  it('una búsqueda normal tras leer el correo, o sin nada privado leído, no pregunta', async () => {
    const { g, asked } = gate();
    await g.check('s', {
      tool: 'web',
      args: { action: 'search', query: 'K7Q2-ZX91-PLM4' },
      actor: 'me',
    });
    expect(asked).toHaveLength(0);
    await g.check('s', MAIL);
    g.settle('s', MAIL, false, BODY);
    await g.check('s', {
      tool: 'web',
      args: { action: 'search', query: 'tiempo en Madrid mañana' },
      actor: 'me',
    });
    expect(asked).toHaveLength(0);
  });
});
