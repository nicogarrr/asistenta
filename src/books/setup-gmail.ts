/** Verificacion SMTP del app password de Gmail (antes de guardarlo en el vault). */

import { createTransport } from 'nodemailer';

export async function verifyGmailSmtp(address: string, appPassword: string): Promise<void> {
  const transporter = createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: address, pass: appPassword },
    // Tope por fase: un SMTP colgado no puede retener el mutex de setup minutos.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    // verify() abre conexion y hace el login: si Google rechaza, lanza.
    await transporter.verify();
  } finally {
    // Cierre SIEMPRE: un verify() que lanza dejaba el socket (y el mutex de
    // setup que envuelve la peticion) retenidos.
    transporter.close();
  }
}
