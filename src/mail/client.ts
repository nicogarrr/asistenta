/**
 * Talking to a real mailbox over IMAP and SMTP.
 *
 * Why these two libraries and not raw sockets: IMAP is not a line protocol you can
 * half-implement. It has literals, untagged responses, a state machine per folder and
 * an IDLE mode whose inactivity timer will disconnect you at exactly the wrong moment.
 * `imapflow` handles all of that and is MIT; `nodemailer` does the same for SMTP. Both
 * are free and both are what everyone else uses, which is the point — a bespoke
 * protocol implementation is the thing that breaks silently at 3 a.m.
 *
 * Everything that can hold a secret is loaded from the vault at the moment of use and
 * discarded when the call ends. `redactSecrets` runs on every error that is about to
 * be logged, because an IMAP error message is allowed to quote the command that failed
 * and that command can carry the login.
 */

import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import { log } from '../log.js';
import { vaultGet } from '../vault.js';
import {
  GMAIL_IMAP_HOST,
  GMAIL_IMAP_PORT,
  GMAIL_SMTP_HOST,
  GMAIL_SMTP_PORT,
  type MailAccount,
  type MailMessage,
  type MailSearchQuery,
  redactSecrets,
  type SendRequest,
  type SendResult,
} from './types.js';

/**
 * Read the account out of the vault.
 *
 * Returns null rather than throwing when it is not configured: a half-configured
 * mailbox is a normal state while the user is still setting it up, and a daemon that
 * refuses to start over a missing app password would be worse than one that says
 * "no hay correo configurado" when asked.
 */
export async function loadAccount(): Promise<MailAccount | null> {
  const address = await vaultGet('mail:address');
  const password = await vaultGet('mail:password');
  if (!address || !password) return null;
  return {
    address,
    password,
    imapHost: (await vaultGet('mail:imapHost')) ?? GMAIL_IMAP_HOST,
    imapPort: Number((await vaultGet('mail:imapPort')) ?? GMAIL_IMAP_PORT),
    smtpHost: (await vaultGet('mail:smtpHost')) ?? GMAIL_SMTP_HOST,
    smtpPort: Number((await vaultGet('mail:smtpPort')) ?? GMAIL_SMTP_PORT),
  };
}

/**
 * Turn an IMAP envelope + body text into the shape the agent sees.
 *
 * The raw message is not kept. It is the RFC 5322 source, which carries the Received
 * chain, the sender's IP and every header the sending server chose to add; none of
 * that is what the agent needs and all of it is a leak.
 */
function toMessage(
  raw: {
    uid: number;
    envelope?: {
      from?: Array<{ address?: string }>;
      to?: Array<{ address?: string }>;
      subject?: string;
      date?: Date;
    };
    source?: Buffer | string;
    flags?: Set<string>;
  },
  folder: string,
): MailMessage {
  const envelope = raw.envelope ?? {};
  const source = typeof raw.source === 'string' ? raw.source : (raw.source?.toString('utf8') ?? '');
  // Body text only: everything after the blank line that separates headers from body,
  // with HTML stripped so a tracking pixel's markup is not quoted back to the user.
  const splitAt = source.search(/\r?\n\r?\n/);
  const body = splitAt >= 0 ? source.slice(splitAt + (source[splitAt] === '\r' ? 4 : 2)) : source;
  const text = body
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    id: String(raw.uid),
    from:
      envelope.from
        ?.map((f) => f.address ?? '')
        .filter(Boolean)
        .join(', ') ?? '',
    to: (envelope.to ?? []).map((t) => t.address ?? '').filter(Boolean),
    subject: envelope.subject ?? '(sin asunto)',
    text: text.slice(0, 8000),
    at: envelope.date ? envelope.date.getTime() : 0,
    seen: raw.flags?.has('\\Seen') ?? false,
    folder,
  };
}

/**
 * Open, do one thing, close.
 *
 * A long-lived IMAP connection is the thing that silently dies behind a NAT and turns
 * the next call into a hang. Short connections are slower per call and always work,
 * which is the right trade for a mailbox the agent touches a few times a day.
 */
async function withImap<T>(
  account: MailAccount,
  folder: string,
  fn: (client: ImapFlow) => Promise<T>,
  deadlineMs?: number,
): Promise<T> {
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: account.address, pass: account.password },
    logger: false,
    socketTimeout: 30_000,
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = (async (): Promise<T> => {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    })();
    if (deadlineMs === undefined) return await work;
    // Deadline duro, no de inactividad: un servidor que gotea bytes derrota el
    // socketTimeout. Al vencer se cierra el socket y la operación MUERE aquí —
    // no queda una conexión colgada apilándose tras el barrido que la abandonó.
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        client.close();
        reject(new Error(`imap: más de ${deadlineMs} ms sin respuesta`));
      }, deadlineMs);
      timer.unref?.();
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  } finally {
    if (timer) clearTimeout(timer);
    await client.logout().catch(() => {});
  }
}

/** Build the IMAP search query the same way for every caller. */
function searchCriteria(query: MailSearchQuery): Record<string, unknown> {
  const criteria: Record<string, unknown> = { all: true };
  if (query.unreadOnly) criteria.unseen = true;
  if (query.since) criteria.since = new Date(query.since);
  if (query.from) criteria.from = query.from;
  if (query.subject) criteria.subject = query.subject;
  return criteria;
}

function matchesFreeText(message: MailMessage, q: string): boolean {
  const needle = q.toLowerCase();
  return (
    message.subject.toLowerCase().includes(needle) || message.text.toLowerCase().includes(needle)
  );
}

export async function searchMail(
  account: MailAccount,
  query: MailSearchQuery,
  limit = 20,
  deadlineMs?: number,
): Promise<MailMessage[]> {
  return withImap(
    account,
    'INBOX',
    async (client) => {
      const uids = await client.search(searchCriteria(query), { uid: true });
      const list = Array.isArray(uids) ? uids : [];
      // Newest first: a mailbox search is almost always "what came in recently", and
      // IMAP hands back uids in ascending order.
      const picked = list.slice(-Math.max(1, limit)).reverse();
      const found: MailMessage[] = [];
      for (const uid of picked) {
        const raw = await client.fetchOne(
          String(uid),
          { uid: true, envelope: true, source: true, flags: true },
          { uid: true },
        );
        if (!raw) continue;
        const message = toMessage(raw as never, 'INBOX');
        if (query.q && !matchesFreeText(message, query.q)) continue;
        found.push(message);
      }
      return found;
    },
    deadlineMs,
  );
}

export async function readMail(account: MailAccount, id: string): Promise<MailMessage | null> {
  return withImap(account, 'INBOX', async (client) => {
    const raw = await client.fetchOne(
      id,
      { uid: true, envelope: true, source: true, flags: true },
      { uid: true },
    );
    return raw ? toMessage(raw as never, 'INBOX') : null;
  });
}

export async function markSeen(account: MailAccount, id: string): Promise<void> {
  await withImap(account, 'INBOX', async (client) => {
    await client.messageFlagsAdd(id, ['\\Seen'], { uid: true });
  });
}

export async function listFolders(account: MailAccount): Promise<string[]> {
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: account.address, pass: account.password },
    logger: false,
    socketTimeout: 30_000,
  });
  try {
    await client.connect();
    const list = await client.list();
    return list.map((f) => f.path);
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Send one message.
 *
 * Sending is the side of the mailbox the user has to approve: it is the only action
 * here that reaches another person. The approval is not asked for here — the gate owns
 * that — but every send is logged so "did it actually go out" is answerable.
 */
export async function sendMail(account: MailAccount, req: SendRequest): Promise<SendResult> {
  if (!req.to.length) return { ok: false, error: 'falta el destinatario' };
  if (!req.subject.trim() || !req.text.trim()) return { ok: false, error: 'falta asunto o cuerpo' };

  const transport = createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpPort === 465,
    auth: { user: account.address, pass: account.password },
  });

  try {
    const info = await transport.sendMail({
      from: account.address,
      to: req.to.join(', '),
      subject: req.subject,
      text: req.text,
      ...(req.attachments?.length ? { attachments: req.attachments } : {}),
      ...(req.inReplyTo ? { inReplyTo: req.inReplyTo, references: req.inReplyTo } : {}),
    });
    log.info('mail sent', { to: req.to.length, subject: req.subject.length });
    return { ok: true, id: String(info.messageId ?? '') };
  } catch (err) {
    const why = redactSecrets(err instanceof Error ? err.message : String(err));
    log.warn('mail send failed', { error: why });
    return { ok: false, error: why };
  } finally {
    transport.close();
  }
}
