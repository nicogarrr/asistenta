/** Verificacion SMTP del app password de Gmail (antes de guardarlo en el vault). */

import { createTransport } from 'nodemailer';

export async function verifyGmailSmtp(address: string, appPassword: string): Promise<void> {
  const transporter = createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: address, pass: appPassword },
  });
  // verify() abre conexion y hace el login: si Google rechaza, lanza.
  await transporter.verify();
  transporter.close();
}
