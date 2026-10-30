import { createTransport } from 'nodemailer';
import { describe, expect, it } from 'vitest';

/**
 * El destinatario aprobado tiene que ser el destinatario real del sobre SMTP.
 *
 * `sendMail` (src/mail/client.ts) une `to` con comas y deja que nodemailer lo
 * analice. nodemailer < 10.3.1 tenía fallos en addressparser (avisos de npm audit):
 * un «;» dentro de comillas cerraba un grupo antes de tiempo y convertía el texto
 * visible en un destinatario. Un remitente con un nombre manipulado podía así
 * desviar una respuesta a otra dirección que no aparece como tal en la aprobación.
 */
async function envelopeTo(to: string): Promise<string[]> {
  const transport = createTransport({ jsonTransport: true });
  const info = await transport.sendMail({ from: 'yo@example.com', to, subject: 's', text: 't' });
  return (info.envelope as { to: string[] }).to;
}

describe('nodemailer: destinatarios del sobre', () => {
  it('un «;» entre comillas dentro de un grupo no crea un destinatario nuevo', async () => {
    await expect(
      envelopeTo('equipo: "a;intruso@evil.example" <ana@example.com>;'),
    ).resolves.toEqual(['ana@example.com']);
  });

  it('el nombre visible nunca se convierte en dirección', async () => {
    await expect(envelopeTo('"Juan; intruso@evil.example" <juan@example.com>')).resolves.toEqual([
      'juan@example.com',
    ]);
    await expect(envelopeTo('Ana (nota; intruso@evil.example) <ana@example.com>')).resolves.toEqual(
      ['ana@example.com'],
    );
  });

  it('varias direcciones separadas por comas siguen llegando todas', async () => {
    await expect(envelopeTo('ana@example.com, "Juan" <juan@example.com>')).resolves.toEqual([
      'ana@example.com',
      'juan@example.com',
    ]);
  });
});
