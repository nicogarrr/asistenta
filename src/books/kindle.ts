import type { MailAccount, SendRequest, SendResult } from '../mail/types.js';
import { sliceSafe } from '../text.js';

/**
 * Delivery to a Kindle by email.
 *
 * Two rules keep this safe. The recipient is the address the user saved, never one the
 * model typed, so a prompt-injected page cannot redirect a send. And the send always
 * goes through a human approval that names the book and the address.
 *
 * Amazon only accepts mail from addresses the user has approved in their Kindle
 * settings; a rejected mail is silent on our side, so the result says "enviado", not
 * "recibido".
 */
export const KINDLE_VAULT_KEY = 'kindle:address';

export function isKindleAddress(address: string): boolean {
  return /^[A-Za-z0-9._%+-]+@(kindle\.com|free\.kindle\.com|kindle\.cn)$/i.test(address.trim());
}

/**
 * Title as shown in the approval text. The title comes from a web catalogue, so it can
 * carry line breaks, quotes or invisible characters that would make the question look
 * like something else ("...\nAprobado: si"). One line, no control or bidi characters,
 * no double quotes, capped.
 */
export function approvalTitle(title: string): string {
  const clean = title
    .normalize('NFC')
    .replace(/[\p{C}\p{Zl}\p{Zp}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/gu, ' ')
    .replace(/["\u201c\u201d\u00ab\u00bb]+/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  const cut = [...clean].slice(0, 100).join('');
  return cut.length < clean.length ? `${cut}...` : cut || 'libro';
}

export function safeFilename(title: string, ext: 'epub' | 'pdf'): string {
  const base = title
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9._ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'libro'}.${ext}`;
}

export interface KindleDeps {
  getAddress: () => Promise<string | null>;
  loadAccount: () => Promise<MailAccount | null>;
  send: (
    account: MailAccount,
    req: SendRequest & { attachments?: Array<{ filename: string; content: Buffer }> },
  ) => Promise<SendResult>;
  requireApproval: (action: string, summary: string) => Promise<boolean>;
}

export type KindleOutcome =
  | { status: 'sent'; to: string }
  | { status: 'declined' }
  | { status: 'no-address' }
  | { status: 'no-mail-account' }
  | { status: 'error'; message: string };

export async function sendToKindle(
  deps: KindleDeps,
  book: { title: string; bytes: Buffer; kind: 'epub' | 'pdf' },
): Promise<KindleOutcome> {
  const to = (await deps.getAddress())?.trim() ?? '';
  if (!to || !isKindleAddress(to)) return { status: 'no-address' };
  const account = await deps.loadAccount();
  if (!account) return { status: 'no-mail-account' };
  const approved = await deps.requireApproval(
    'book:kindle',
    `Enviar "${approvalTitle(book.title)}" (${book.kind.toUpperCase()}) a tu Kindle ${to}, desde ${account.address}`,
  );
  if (!approved) return { status: 'declined' };
  const result = await deps.send(account, {
    to: [to],
    subject: sliceSafe(book.title, 120),
    text: 'Libro enviado desde Asistenta.',
    attachments: [{ filename: safeFilename(book.title, book.kind), content: book.bytes }],
  });
  return result.ok
    ? { status: 'sent', to }
    : { status: 'error', message: result.error ?? 'error desconocido' };
}
