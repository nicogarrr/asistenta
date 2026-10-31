import { describe, expect, it } from 'vitest';
import { type MailToolDeps, runMailTool } from '../src/tools/mail.js';
import { mailReadFailText } from '../src/tools/mail-rules.js';

// robustez-7: los fallos de correo llegan al modelo/chat en castellano llano;
// el texto crudo (rutas, IMAP, red) va solo al log.
const RAW = 'ENOENT: no such file /home/nico/.pa/vault.json at Object.openSync';

function deps(over: Partial<MailToolDeps>): MailToolDeps {
  return {
    allowed: () => true,
    account: async () => null,
    search: async () => [],
    ...over,
  } as MailToolDeps;
}

describe('correo: errores en castellano llano', () => {
  it('cuenta de lectura con datos rotos: sin el error crudo', async () => {
    const out = await runMailTool(
      { action: 'buscar' },
      deps({
        account: async () => {
          throw new Error(RAW);
        },
      }),
    );
    expect(out).toContain('Los datos guardados de la cuenta no son válidos.');
    expect(out).not.toContain('ENOENT');
    expect(out).not.toContain('/home/nico');
  });

  it('cuenta de envío con datos rotos: sin el error crudo', async () => {
    const out = await runMailTool(
      { action: 'nuevo', para: 'ana@ejemplo.es', asunto: 'Hola', texto: 'Qué tal' },
      deps({
        sendAccount: async () => {
          throw new Error(RAW);
        },
        send: async () => undefined,
      } as unknown as Partial<MailToolDeps>),
    );
    expect(out).toContain('Los datos guardados de la cuenta no son válidos.');
    expect(out).not.toContain('ENOENT');
  });

  it('correo_reglas: fallo al leer → línea clara según el caso', () => {
    const auth = mailReadFailText(
      new Error('Command failed: AUTHENTICATIONFAILED Invalid credentials (Failure)'),
    );
    expect(auth).toContain('contraseña de aplicación');
    expect(auth).not.toContain('AUTHENTICATIONFAILED');
    const net = mailReadFailText(
      Object.assign(new Error('getaddrinfo ENOTFOUND imap.gmail.com'), { code: 'ENOTFOUND' }),
    );
    expect(net).toContain('no hay conexión');
    expect(net).not.toContain('ENOTFOUND');
    expect(mailReadFailText(new Error(RAW))).toBe(
      'No pude leer el correo ahora. Prueba en un rato.',
    );
  });
});
