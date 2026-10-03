/**
 * The mailbox, as shapes the agent can reason about.
 *
 * The account is deliberately split out from the messages: `password` exists only in
 * memory, is never serialised, and is never part of a `MailMessage`. That separation
 * is the whole point of the module — the agent works with senders, subjects and
 * bodies, and the thing that unlocks the account never appears in a tool result the
 * model reads.
 */

export interface MailAccount {
  address: string;
  /** In memory only. Never serialised, never logged, never returned by a tool. */
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

export interface MailMessage {
  id: string;
  from: string;
  to: string[];
  subject: string;
  /** Plain-text body only. The raw source is discarded so no header can leak. */
  text: string;
  /** Epoch ms, best effort. */
  at: number;
  seen: boolean;
  folder: string;
}

export interface MailSearchQuery {
  from?: string;
  subject?: string;
  /** Free text over subject and body. */
  q?: string;
  /** Only messages at or after this epoch ms. */
  since?: number;
  unreadOnly?: boolean;
}

export interface SendRequest {
  to: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
}

export interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/** Gmail's defaults. Overridable through the vault for anyone not on Gmail. */
export const GMAIL_IMAP_HOST = 'imap.gmail.com';
export const GMAIL_IMAP_PORT = 993;
export const GMAIL_SMTP_HOST = 'smtp.gmail.com';
export const GMAIL_SMTP_PORT = 465;

/**
 * Redact anything that looks like a credential before it reaches a log line or a tool
 * result. Broad on purpose: the cost of over-redacting an error message is a slightly
 * less useful message, and the cost of under-redacting one is a password in a file
 * that lives on disk forever.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/\b[A-Za-z0-9]{4}[\s-]?[A-Za-z0-9]{4}[\s-]?[A-Za-z0-9]{4}[\s-]?[A-Za-z0-9]{4}\b/g, '[credencial]')
    .replace(/(password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1: [redactado]');
}
