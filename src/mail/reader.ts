/** Epoch-bound, read-only Gmail reader. Header claims are metadata, never authority. */
import { createHash } from 'node:crypto';
import { type FetchMessageObject, ImapFlow } from 'imapflow';
import { toMessage } from './client.js';
import type { ReadMailAccount } from './idle.js';
import type { MailMessage } from './types.js';

export interface ReplyMessage extends MailMessage {
  messageId: string | null;
  references: string[];
  replyTo: string[];
  authenticationResults: string;
  threadDigest: string;
  threadCount: number;
}
export function parseHeaderMetadata(headers: Buffer | undefined) {
  const text = (headers?.toString('utf8') ?? '').replace(/\r?\n[ \t]+/g, ' ');
  const fields = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const key = line.slice(0, i).toLowerCase();
    fields.set(key, [...(fields.get(key) ?? []), line.slice(i + 1).trim()]);
  }
  const ids = (s: string) => s.match(/<[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+>/g) ?? [];
  const mid = fields.get('message-id') ?? [];
  return {
    messageId:
      mid.length === 1 && ids(mid[0] ?? '').length === 1 && ids(mid[0] ?? '')[0] === mid[0]
        ? (mid[0] ?? null)
        : null,
    references: [...new Set(ids((fields.get('references') ?? []).join(' ')))].slice(-20),
    authenticationResults: (fields.get('authentication-results') ?? [])
      .join(' | ')
      .replace(/\s+/g, ' ')
      .slice(0, 350),
  };
}
const QUERY = {
  uid: true,
  envelope: true,
  source: { maxLength: 32768 },
  flags: true,
  threadId: true,
  headers: ['message-id', 'references', 'authentication-results'],
} as const;
async function withReader<T>(
  account: ReadMailAccount,
  fn: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: account.address, pass: account.password },
    logger: false,
    socketTimeout: 15000,
  });
  const timer = setTimeout(() => client.close(), 20000);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    clearTimeout(timer);
    client.close();
  }
}
function message(raw: FetchMessageObject): ReplyMessage {
  const meta = parseHeaderMetadata(raw.headers);
  return {
    ...toMessage(raw as never, 'INBOX'),
    ...meta,
    replyTo: (raw.envelope?.replyTo ?? []).map((a) => a.address ?? '').filter(Boolean),
    threadDigest: '',
    threadCount: 0,
  };
}
export async function listReplyInbox(
  account: ReadMailAccount,
): Promise<Array<{ ref: string; from: string; subject: string }>> {
  return withReader(account, async (client) => {
    const box = await client.mailboxOpen('INBOX', { readOnly: true });
    if (!box.readOnly) throw new Error('Read-only required');
    const found = await client.search({ all: true }, { uid: true });
    if (!Array.isArray(found)) throw new Error('Search failed');
    const result = [];
    for (const uid of found.slice(-8).reverse()) {
      const row = await client.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true });
      if (row)
        result.push({
          ref: `${box.uidValidity}:${uid}`,
          from: row.envelope?.from?.map((a) => a.address ?? '').join(', ') ?? '',
          subject: row.envelope?.subject ?? '(sin asunto)',
        });
    }
    return result;
  });
}
export async function readReplyThread(
  account: ReadMailAccount,
  ref: string,
): Promise<ReplyMessage | null> {
  if (!/^[1-9]\d*:[1-9]\d*$/.test(ref)) throw new Error('Invalid reference');
  return withReader(account, async (client) => {
    const [validity, uid] = ref.split(':');
    const inbox = await client.mailboxOpen('INBOX', { readOnly: true });
    if (!inbox.readOnly || String(inbox.uidValidity) !== validity)
      throw new Error('Referencia caducada');
    const raw = await client.fetchOne(
      uid ?? '',
      { ...QUERY, headers: [...QUERY.headers] },
      { uid: true },
    );
    if (!raw) return null;
    if (!raw.threadId) throw new Error('Servidor sin identidad de hilo Gmail');
    const result = message(raw);
    if (!result.messageId) throw new Error('Sin Message-ID RFC válido');
    // Gmail's special-use All Mail includes user's sent replies as well as inbox messages.
    const folders = await client.list();
    const all = folders.filter((f) => f.specialUse === '\\All');
    if (all.length !== 1) throw new Error('No se puede verificar Todo el correo');
    const box = await client.mailboxOpen(all[0]?.path ?? '', { readOnly: true });
    if (!box.readOnly) throw new Error('Read-only required');
    const uids = await client.search({ threadId: raw.threadId }, { uid: true });
    if (!Array.isArray(uids) || !uids.length || uids.length > 30)
      throw new Error('Hilo no verificable o demasiado largo');
    const rows = [];
    for (const id of uids.sort((a, b) => a - b)) {
      const row = await client.fetchOne(
        String(id),
        { uid: true, envelope: true, headers: ['message-id', 'references'] },
        { uid: true },
      );
      if (!row) throw new Error('Hilo cambió durante lectura');
      rows.push([
        row.uid,
        row.envelope?.messageId,
        row.envelope?.from,
        row.envelope?.to,
        row.envelope?.subject,
        row.envelope?.date,
        parseHeaderMetadata(row.headers).messageId,
      ]);
    }
    const after = await client.search({ threadId: raw.threadId }, { uid: true });
    if (
      !Array.isArray(after) ||
      JSON.stringify([...after].sort((a, b) => a - b)) !== JSON.stringify(uids)
    )
      throw new Error('Hilo cambió durante lectura');
    result.threadCount = rows.length;
    result.threadDigest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    return result;
  });
}
/** Only an explicit reply to one specific bot card selects "ese". Never last-message guessing. */
export function resolveReplyCard(
  text: string,
  replyTo: string | undefined,
  cards: Map<string, string>,
): string | null {
  return /^responde(?:r)? a ese\s*\n/i.test(text) && replyTo ? (cards.get(replyTo) ?? null) : null;
}
