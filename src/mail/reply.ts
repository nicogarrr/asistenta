/** Explicit owner-command reply adapter. No autonomous send entry point or model tool. */
import { createHash } from 'node:crypto';
import { vaultGet } from '../vault.js';
import { sendMail } from './client.js';
import type { ReadMailAccount } from './idle.js';
import { type ReplyMessage, readReplyThread } from './reader.js';
import type { MailAccount, SendResult } from './types.js';

export async function loadSendMailAccount(
  get: (key: string) => Promise<string | undefined | null> = vaultGet,
): Promise<MailAccount | null> {
  const address = (await get('mailSend:address'))?.trim();
  const password = (await get('mailSend:password'))?.replace(/ /g, '');
  if (!address || !password) return null;
  if (!/^[^@\s]+@gmail\.com$/i.test(address) || !/^[a-zA-Z]{16}$/.test(password))
    throw new Error('mailSend requiere Gmail y contraseña de aplicación dedicada.');
  return {
    address,
    password,
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
  };
}
function recipient(from: string): string {
  if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(from))
    throw new Error('Remitente no es una dirección única válida.');
  return from;
}
function fingerprint(message: ReplyMessage): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        message.id,
        message.from,
        message.subject,
        message.text,
        message.at,
        message.messageId,
        message.references,
        message.replyTo,
        message.threadDigest,
      ]),
    )
    .digest('hex');
}
export interface ReplyDeps {
  readAccount: () => Promise<ReadMailAccount | null>;
  sendAccount: () => Promise<MailAccount | null>;
  read?: (account: ReadMailAccount, id: string) => Promise<ReplyMessage | null>;
  send?: typeof sendMail;
  review: (preview: string) => Promise<boolean>;
}
/** Owner-only dispatcher invokes this once per explicit command, never from a model. */
export async function replyOnOwnerRequest(
  id: string,
  body: string,
  deps: ReplyDeps,
): Promise<SendResult> {
  if (!/^[1-9]\d*:[1-9]\d*$/.test(id) || !body.trim() || body.length > 2500)
    throw new Error('Necesita UIDVALIDITY:UID y texto de 1 a 2500 caracteres.');
  const reader = await deps.readAccount();
  const sender = await deps.sendAccount();
  if (!reader || !sender) throw new Error('Falta configurar mailRead o mailSend.');
  if (reader.address.toLowerCase() !== sender.address.toLowerCase())
    throw new Error('Cuenta de lectura y envío distintas.');
  const read = deps.read ?? readReplyThread;
  const original = await read(reader, id);
  if (!original) throw new Error('Correo no disponible.');
  if (!original.messageId || !original.threadDigest) throw new Error('Hilo no verificable');
  const to = recipient(original.from);
  const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
  if (/[\r\n\u2028\u2029]/u.test(subject) || subject.length > 300)
    throw new Error('Asunto no válido.');
  const text = body.trim();
  const preview = `De: ${sender.address}\nPara: ${to}\nCC/BCC: nadie\nRemitente observado, identidad no verificada. Reply-To no se usa: ${original.replyTo.join(', ') || 'ninguno'}. Auth informativa (sin verificar): ${original.authenticationResults || 'no disponible'}. Hilo: ${original.threadCount} mensajes.\nAsunto: ${subject}\n\n${text}\n\n¿Enviar exactamente este correo?`;
  if (!(await deps.review(preview))) return { ok: false, error: 'Envío no aprobado.' };
  // Last read before sending: changed source requires a new review, never a silent edit.
  const current = await read(reader, id);
  if (!current || fingerprint(current) !== fingerprint(original))
    return { ok: false, error: 'El correo cambió durante la revisión. No enviado.' };
  return (deps.send ?? sendMail)(sender, {
    to: [to],
    subject,
    text,
    inReplyTo: original.messageId,
    references: [...original.references, original.messageId],
  });
}
