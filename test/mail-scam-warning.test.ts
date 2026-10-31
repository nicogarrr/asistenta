import { describe, expect, it } from 'vitest';
import { mailAttentionText, scamWarning } from '../src/mail/triage.js';
import { createMailTool } from '../src/tools/mail.js';

const SCAM = {
  from: 'avisos@correos-entrega.example',
  subject: 'Correos: paquete retenido, pago urgente de 1,99 €',
  text: 'Pague hoy mismo con su tarjeta o el envío será devuelto.',
  replyTo: ['cobros@otro.example'],
};
const OK = { from: 'ana@amiga.example', subject: '¿Cenamos el sábado?', text: 'Dime algo.' };

describe('aviso de estafa al llegar o leer un correo (solo avisa)', () => {
  it('una línea clara para lo sospechoso, nada para lo normal', () => {
    expect(scamWarning(SCAM)).toMatch(/^⚠️ Posible estafa: .+\. No pagues ni des datos/);
    expect(scamWarning(OK)).toBe('');
  });

  it('el correo nuevo llega a la atención con el aviso delante', () => {
    expect(mailAttentionText(SCAM).split('\n')[0]).toMatch(/^⚠️ Posible estafa/);
    expect(mailAttentionText(OK)).toBe('¿Cenamos el sábado?\nDime algo.');
  });

  it('«léeme ese correo» lleva el aviso', async () => {
    const tool = createMailTool({
      allowed: () => true,
      search: async () => [],
      account: async () => ({
        address: 'n@x.example',
        password: 'p',
        imapHost: 'h',
        imapPort: 993,
      }),
      read: async () => ({
        ...SCAM,
        to: ['n@x.example'],
        at: Date.now(),
        id: '1',
        seen: false,
        folder: 'INBOX',
      }),
    } as never);
    const r = await tool.execute('t', { action: 'leer', ref: '7:1' } as never);
    const text = (r.content[0] as { text: string }).text;
    expect(text.split('\n')[1]).toMatch(/^⚠️ Posible estafa/);
  });
});
