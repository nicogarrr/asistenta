import { describe, expect, it } from 'vitest';
import type { SendRequest } from '../src/mail/types.js';
import { type MailToolDeps, mailSendFailText, runMailTool } from '../src/tools/mail.js';

// «No enviado: <motivo del servidor>» llevaba el texto SMTP crudo al chat. Ahora una frase
// llana por caso común; el crudo, solo al log.
const reader = { address: 'nico@gmail.com', password: 'x', imapHost: 'h', imapPort: 993 };
const sender = { ...reader, smtpHost: 'smtp', smtpPort: 465 };

function deps(over: Partial<MailToolDeps>): MailToolDeps {
  return {
    allowed: () => true,
    account: async () => reader,
    search: async () => [],
    read: async () => null,
    sendAccount: async () => sender,
    send: async () => ({ ok: true, id: '<x>' }),
    ...over,
  };
}

const nuevo = { action: 'nuevo', para: ['ana@ejemplo.es'], asunto: 'Hola', cuerpo: 'Qué tal' };
const failingWith = (error: string) =>
  runMailTool(nuevo, deps({ send: async (_a, _r: SendRequest) => ({ ok: false, error }) }));
const RAW = /\d{3}[- ]\d\.\d\.\d|EAUTH|ETIMEDOUT|smtp\.|gsmtp|https?:|ana@/i;

describe('correo: motivo de «No enviado» en castellano llano', () => {
  it('contraseña rechazada', async () => {
    const out = await failingWith(
      'Invalid login: 535-5.7.8 Username and Password not accepted. Learn more at https://support.google.com/mail/?p=BadCredentials x1-20020a gsmtp',
    );
    expect(out).toMatch(/^No enviado: Gmail no acepta la contraseña de aplicación/);
    expect(out).not.toMatch(RAW);
    expect(out).toContain('No lo reintento solo');
  });

  it('sin conexión', async () => {
    const out = await failingWith('connect ETIMEDOUT 142.250.102.108:465');
    expect(out).toContain('no hay conexión con el servidor de correo');
    expect(out).not.toMatch(RAW);
    expect(out).not.toContain('142.250');
  });

  it('dirección rechazada', async () => {
    const out = await failingWith(
      "Can't send mail - all recipients were rejected: 550-5.1.1 The email account that you tried to reach does not exist ana@ejemplo.es gsmtp",
    );
    expect(out).toContain('rechazó alguna dirección');
    expect(out).not.toMatch(RAW);
  });

  it('demasiado grande y límite diario', async () => {
    expect(
      await failingWith(
        "Message failed: 552-5.3.4 Your message exceeded Google's message size limits",
      ),
    ).toContain('pesa demasiado');
    expect(await failingWith('550 5.4.5 Daily user sending limit exceeded')).toContain(
      'límite de envíos',
    );
  });

  it('un motivo raro tampoco sale crudo', async () => {
    const out = await failingWith(
      '451 4.3.0 Mail server temporarily rejected message. xyz - gsmtp',
    );
    expect(out).toMatch(/^No enviado: el servidor de correo no lo aceptó\./);
    expect(out).not.toMatch(/451|gsmtp/);
  });

  it('un fallo al leer el original (IMAP) no sale crudo', async () => {
    const out = await runMailTool(
      { action: 'responder', ref: '7:42', para: ['ana@ejemplo.es'], asunto: 'Re: x', cuerpo: 'Sí' },
      deps({
        read: async () => {
          throw new Error('Command failed: UID FETCH 42 (BODY.PEEK[]) BAD Could not parse command');
        },
      }),
    );
    expect(out).toMatch(/^No enviado: /);
    expect(out).not.toMatch(/UID FETCH|BAD|parse/);
  });

  it('los avisos propios, ya claros, se dicen tal cual', () => {
    expect(mailSendFailText('falta el destinatario', 'x')).toBe('falta el destinatario');
  });
});
