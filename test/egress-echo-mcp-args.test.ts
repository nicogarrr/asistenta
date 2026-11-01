import { describe, expect, it } from 'vitest';
import { Gate } from '../src/permissions.js';

function gate() {
  const asked: string[] = [];
  const g = new Gate({
    protectedPaths: [],
    allow: ['mail', 'mcp_notes_create'],
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

async function mcpAfterMail(args: Record<string, unknown>, readMail = true) {
  const { g, asked } = gate();
  if (readMail) {
    await g.check('s', MAIL);
    g.settle('s', MAIL, false, BODY);
  }
  await g.check('s', { tool: 'mcp_notes_create', args, actor: 'me' });
  return asked;
}

describe('eco del contenido privado en argumentos de herramientas MCP', () => {
  it('un texto con un trozo literal del correo leído pregunta', async () => {
    const asked = await mcpAfterMail({
      title: 'x',
      body: 'Quedamos en Calle del Pez 14, portal 3B',
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/mcp_notes_create/);
  });

  it('también dentro de un objeto o lista', async () => {
    const asked = await mcpAfterMail({ items: [{ text: 'Calle del Pez 14, portal 3B' }] });
    expect(asked).toHaveLength(1);
  });

  it('sin eco, o sin nada privado leído, no pregunta', async () => {
    expect(await mcpAfterMail({ title: 'Lista de la compra', body: 'pan y leche' })).toHaveLength(
      0,
    );
    expect(await mcpAfterMail({ body: 'Calle del Pez 14, portal 3B' }, false)).toHaveLength(0);
  });
});
