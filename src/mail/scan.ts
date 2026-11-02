/**
 * Leer cabeceras del buzón para clasificar, sin bajar cuerpos: remitente, asunto, fecha
 * y las cabeceras de listas/baja/autenticación. Solo lectura (mailbox en readOnly).
 */
import { uidValidityOf } from './move.js';
import type { MailAccount } from './types.js';

export const SCAN_HEADERS = [
  'list-unsubscribe',
  'list-unsubscribe-post',
  'list-id',
  'precedence',
  'auto-submitted',
  'authentication-results',
] as const;

export interface ScannedMail {
  uid: number;
  from: string;
  fromName: string;
  replyTo: string[];
  subject: string;
  at: number;
  seen: boolean;
  headers: Record<string, string>;
}

/** Lo mínimo de ImapFlow que usa el escaneo (los tests pasan uno falso). */
export interface ImapLike {
  connect(): Promise<unknown>;
  mailboxOpen(path: string, opts: { readOnly: boolean }): Promise<unknown>;
  search(query: Record<string, unknown>, opts: { uid: true }): Promise<number[] | false>;
  fetchOne(uid: string, query: Record<string, unknown>, opts: { uid: true }): Promise<unknown>;
  logout(): Promise<unknown>;
}

export function parseHeaders(raw: Buffer | string | undefined): Record<string, string> {
  const text = (raw ?? '').toString().replace(/\r?\n[ \t]+/g, ' ');
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    out[key] = out[key] ? `${out[key]} | ${line.slice(i + 1).trim()}` : line.slice(i + 1).trim();
  }
  return out;
}

export async function imapFor(account: MailAccount): Promise<ImapLike> {
  // imapflow (y sus ~150 módulos) solo se carga cuando de verdad se escanea el correo.
  const { ImapFlow } = await import('imapflow');
  return new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: account.address, pass: account.password },
    logger: false,
    socketTimeout: 30_000,
  }) as unknown as ImapLike;
}

interface RawRow {
  uid: number;
  envelope?: {
    from?: Array<{ address?: string; name?: string }>;
    replyTo?: Array<{ address?: string }>;
    subject?: string;
    date?: Date;
  };
  flags?: Set<string>;
  headers?: Buffer;
}

/** Los `limit` correos más nuevos de la bandeja (desde `since`), solo cabeceras. */
export async function scanInbox(
  client: ImapLike,
  opts: { limit: number; since?: number; box?: { uidValidity: string } },
): Promise<ScannedMail[]> {
  try {
    await client.connect();
    const box = await client.mailboxOpen('INBOX', { readOnly: true });
    if (opts.box) opts.box.uidValidity = uidValidityOf(box);
    const criteria: Record<string, unknown> = { all: true };
    if (opts.since) criteria.since = new Date(opts.since);
    const uids = await client.search(criteria, { uid: true });
    const newest = (Array.isArray(uids) ? uids : []).slice().reverse().slice(0, opts.limit);
    const found: ScannedMail[] = [];
    for (const uid of newest) {
      const row = (await client.fetchOne(
        String(uid),
        { uid: true, envelope: true, flags: true, headers: [...SCAN_HEADERS] },
        { uid: true },
      )) as RawRow | false | null;
      if (!row) continue;
      const from = row.envelope?.from?.[0];
      const date = row.envelope?.date;
      found.push({
        uid: row.uid,
        from: (from?.address ?? '').toLowerCase(),
        fromName: from?.name ?? '',
        replyTo: (row.envelope?.replyTo ?? []).map((a) => a.address ?? '').filter(Boolean),
        subject: row.envelope?.subject?.trim() || '(sin asunto)',
        at: date && Number.isFinite(date.getTime()) ? date.getTime() : 0,
        seen: row.flags?.has('\\Seen') ?? false,
        headers: parseHeaders(row.headers),
      });
    }
    return found;
  } finally {
    await client.logout().catch(() => {});
  }
}
