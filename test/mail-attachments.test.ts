import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { attachmentsOf } from '../src/mail/reader.js';
import { MAIL_SEND_SETUP, runMailTool } from '../src/tools/mail.js';

describe('correo: adjuntos al leer', () => {
  it('saca nombre y tamaño de BODYSTRUCTURE, sin contar el texto', () => {
    const tree = {
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain', size: 10 },
        {
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: 'factura.pdf' },
          size: 204800,
        },
        { type: 'image/png', parameters: { name: 'foto\npng' }, size: 512 },
      ],
    };
    expect(attachmentsOf(tree)).toEqual([
      { name: 'factura.pdf', size: 204800 },
      { name: 'foto png', size: 512 },
    ]);
    expect(attachmentsOf(undefined)).toEqual([]);
  });
  it('leer enseña los adjuntos', async () => {
    const out = await runMailTool(
      { action: 'leer', ref: '7:1' },
      {
        allowed: () => true,
        account: async () => ({
          address: 'a@gmail.com',
          password: 'x',
          imapHost: 'h',
          imapPort: 1,
        }),
        search: async () => [],
        read: async () => ({
          from: 'b@c.es',
          to: [],
          subject: 'F',
          text: 't',
          at: 0,
          attachments: [{ name: 'factura.pdf', size: 204800 }],
        }),
      },
    );
    expect(out).toContain('Adjuntos: factura.pdf (200 KB)');
  });
  it('la guía existe y coincide con el aviso de configuración', () => {
    const doc = readFileSync('docs/correo.md', 'utf8');
    expect(doc).toContain('pa vault set mailSend:address tu@gmail.com');
    expect(MAIL_SEND_SETUP).toContain('pa vault set mailSend:address tu@gmail.com');
    expect(doc).toContain('Ningún correo sale sin tu sí a ese borrador exacto');
  });
});
