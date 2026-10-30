/**
 * Buzon del canal de correo (F10): trae los correos nuevos con «[asistenta]»
 * en el asunto, solo lectura, desde el ultimo UID visto. La primera vez (o si
 * cambia UIDVALIDITY) arranca en el final del buzon: el correo viejo nunca
 * se convierte en turno. La verificacion (lista + dkim) la hace
 * src/channels/email.ts; aqui solo se lee.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { ImapFlow } from 'imapflow';
import type { RawCommandMail } from '../channels/email.js';
import type { ReadMailAccount } from './idle.js';
import { extractBodyText } from './mime.js';

export interface CommandCursor {
  validity: string;
  /** Siguiente UID por leer. */
  next: number;
}

/** Lo minimo de ImapFlow que hace falta (inyectable en los tests). */
export interface CommandImap {
  open(): Promise<{ uidValidity: bigint | number | string; uidNext: number }>;
  search(fromUid: number): Promise<number[]>;
  fetch(uid: number): Promise<{ headers: string; source: string; size: number } | null>;
}

const MAX_PER_POLL = 10;

export async function pollCommandMail(
  imap: CommandImap,
  cursor: CommandCursor | null,
): Promise<{ mails: RawCommandMail[]; cursor: CommandCursor }> {
  const box = await imap.open();
  const validity = String(box.uidValidity);
  if (!cursor || cursor.validity !== validity) {
    return { mails: [], cursor: { validity, next: box.uidNext } };
  }
  const uids = (await imap.search(cursor.next))
    .filter((u) => u >= cursor.next)
    .sort((a, b) => a - b)
    .slice(0, MAX_PER_POLL);
  const mails: RawCommandMail[] = [];
  let next = cursor.next;
  for (const uid of uids) {
    next = uid + 1;
    const raw = await imap.fetch(uid);
    if (!raw) continue;
    mails.push({
      uid: String(uid),
      headers: raw.headers,
      text: extractBodyText(raw.source),
      size: raw.size,
    });
  }
  return { mails, cursor: { validity, next } };
}

export function loadCommandCursor(file: string): CommandCursor | null {
  try {
    if (!existsSync(file)) return null;
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<CommandCursor>;
    return typeof v.validity === 'string' && Number.isInteger(v.next)
      ? { validity: v.validity, next: v.next as number }
      : null;
  } catch {
    return null;
  }
}

export function saveCommandCursor(file: string, cursor: CommandCursor): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cursor)}\n`);
  renameSync(tmp, file);
}

/** Una pasada real contra Gmail (solo lectura), con plazo. */
export async function pollGmailCommandMail(
  account: ReadMailAccount,
  cursorFile: string,
): Promise<RawCommandMail[]> {
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: account.address, pass: account.password },
    logger: false,
    socketTimeout: 15_000,
  });
  const timer = setTimeout(() => client.close(), 30_000);
  try {
    await client.connect();
    const imap: CommandImap = {
      open: async () => {
        const box = await client.mailboxOpen('INBOX', { readOnly: true });
        if (!box.readOnly) throw new Error('Se requiere el buzón en solo lectura');
        return { uidValidity: box.uidValidity, uidNext: box.uidNext };
      },
      search: async (fromUid) => {
        const found = await client.search(
          { uid: `${fromUid}:*`, subject: '[asistenta]' },
          { uid: true },
        );
        return Array.isArray(found) ? found : [];
      },
      fetch: async (uid) => {
        const raw = await client.fetchOne(
          String(uid),
          { headers: true, source: { maxLength: 65_536 }, size: true },
          { uid: true },
        );
        if (!raw) return null;
        return {
          headers: raw.headers?.toString('utf8') ?? '',
          source: raw.source?.toString('utf8') ?? '',
          size: raw.size ?? 0,
        };
      },
    };
    const { mails, cursor } = await pollCommandMail(imap, loadCommandCursor(cursorFile));
    saveCommandCursor(cursorFile, cursor);
    return mails;
  } finally {
    clearTimeout(timer);
    client.close();
  }
}
