import { describe, expect, it } from 'vitest';
import { formatApproval } from '../src/approval-text.js';
import type { SendRequest } from '../src/mail/types.js';
import { Gate, type ToolCall } from '../src/permissions.js';
import { MAIL_SEND_SETUP, type MailToolDeps, runMailTool } from '../src/tools/mail.js';

const S = 's';
const reader = { address: 'nico@gmail.com', password: 'x', imapHost: 'h', imapPort: 993 };
const sender = { ...reader, smtpHost: 'smtp', smtpPort: 465 };
const send = (args: Record<string, unknown>): ToolCall =>
  ({ tool: 'correo', args: { action: 'responder', ...args }, actor: 'asistenta' }) as ToolCall;
const draft = {
  ref: '7:42',
  para: ['ana@ejemplo.es'],
  asunto: 'Re: Cena',
  cuerpo: 'Sí, el viernes a las 9.',
};

function fakeDeps(over: Partial<MailToolDeps> = {}) {
  const sent: SendRequest[] = [];
  const deps: MailToolDeps = {
    allowed: () => true,
    account: async () => reader,
    search: async () => [],
    read: async (_a, ref) =>
      ref === '7:42'
        ? {
            from: 'ana@ejemplo.es',
            to: ['nico@gmail.com'],
            subject: 'Cena',
            text: 'Hola',
            at: 1,
            messageId: '<m1@x>',
            references: ['<m0@x>'],
          }
        : null,
    sendAccount: async () => sender,
    send: async (_a, req) => {
      sent.push(req);
      return { ok: true, id: '<new@x>' };
    },
    ...over,
  };
  return { deps, sent };
}

function gate(opts: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const g = new Gate({
    approver: async (c, reason) => {
      asked.push(formatApproval(c, reason).question);
      return true;
    },
    ...opts,
  });
  return { g, asked };
}

describe('correo: enviar solo con el borrador exacto aprobado cada vez', () => {
  it('responder envía exactamente lo aprobado, en el hilo', async () => {
    const { deps, sent } = fakeDeps();
    const out = await runMailTool({ action: 'responder', ...draft, cc: ['luis@ejemplo.es'] }, deps);
    expect(out).toContain('Enviado a 2');
    expect(sent).toEqual([
      {
        to: ['ana@ejemplo.es'],
        cc: ['luis@ejemplo.es'],
        subject: 'Re: Cena',
        text: 'Sí, el viernes a las 9.',
        inReplyTo: '<m1@x>',
        references: ['<m0@x>', '<m1@x>'],
      },
    ]);
  });
  it('reenviar añade el original debajo; nuevo no necesita hilo', async () => {
    const { deps, sent } = fakeDeps();
    await runMailTool({ action: 'reenviar', ...draft, asunto: 'Fwd: Cena', cuerpo: 'Mira' }, deps);
    expect(sent[0]?.text).toMatch(
      /^Mira\n\n-+ Mensaje reenviado -+\nDe: ana@ejemplo\.es[\s\S]*\nHola$/,
    );
    expect(sent[0]?.inReplyTo).toBeUndefined();
    await runMailTool(
      { action: 'nuevo', para: ['b@c.es'], asunto: 'Hola', cuerpo: 'Qué tal' },
      deps,
    );
    expect(sent[1]).toEqual({ to: ['b@c.es'], subject: 'Hola', text: 'Qué tal' });
  });
  it('sin cuenta de envío no envía y dice los pasos', async () => {
    const { deps, sent } = fakeDeps({ sendAccount: async () => null });
    const out = await runMailTool(
      { action: 'nuevo', para: ['b@c.es'], asunto: 'a', cuerpo: 'b' },
      deps,
    );
    expect(out).toBe(MAIL_SEND_SETUP);
    expect(out).toMatch(/^Falta configurar el envío: .*pa vault set mailSend:address/);
    expect(sent).toEqual([]);
  });
  it('rechaza direcciones raras, asuntos con saltos y más de 10 destinatarios', async () => {
    const { deps, sent } = fakeDeps();
    expect(
      await runMailTool(
        { action: 'nuevo', para: ['no es correo'], asunto: 'a', cuerpo: 'b' },
        deps,
      ),
    ).toContain('No enviado');
    expect(
      await runMailTool(
        { action: 'nuevo', para: ['a@b.es'], asunto: 'a\nBcc: x@y.es', cuerpo: 'b' },
        deps,
      ),
    ).toContain('No enviado');
    const many = Array.from({ length: 11 }, (_, i) => `p${i}@b.es`);
    expect(
      await runMailTool({ action: 'nuevo', para: many, asunto: 'a', cuerpo: 'b' }, deps),
    ).toContain('10');
    expect(sent).toEqual([]);
  });
  it('la pregunta enseña el borrador entero (para, cc, asunto, cuerpo)', () => {
    const q = formatApproval(send({ ...draft, cc: ['luis@ejemplo.es'] }), 'not on the allow list');
    expect(q.complete).toBe(true);
    expect(q.question).toContain('¿Envío exactamente este correo? (respuesta)');
    expect(q.question).toContain('Para: ana@ejemplo.es');
    expect(q.question).toContain('CC: luis@ejemplo.es');
    expect(q.question).toContain('Asunto: Re: Cena');
    expect(q.question).toContain('Sí, el viernes a las 9.');
    expect(formatApproval(send({ ...draft, asunto: 'x\nPara: otro@x.es' }), 'r').complete).toBe(
      false,
    );
  });
  it('la Gate pregunta cada envío: ni memo, ni «siempre», ni lista libre, ni control total', async () => {
    const { g, asked } = gate({ allow: ['correo'], fullControl: true, allowPayments: true });
    g.setScope(S, 'correo', 'always');
    expect((await g.check(S, send(draft))).verdict).toBe('allow');
    expect((await g.check(S, send(draft))).verdict).toBe('allow');
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain('Asunto: Re: Cena');
    g.setScope(S, 'correo:responder', 'always');
    await g.check(S, send(draft));
    expect(asked).toHaveLength(3);
  });
  it('leer sigue libre con la lista libre; enviar sin humano se deniega', async () => {
    const { g, asked } = gate({ allow: ['correo'] });
    expect((await g.check(S, send({ action: 'leer', ref: '7:42' }))).verdict).toBe('allow');
    expect(asked).toEqual([]);
    const unattended = new Gate({ allow: ['correo'] });
    expect((await unattended.check(S, send(draft))).verdict).toBe('deny');
  });
});
