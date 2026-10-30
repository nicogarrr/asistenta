/** Read-only IMAP IDLE transport. No polling fallback, no SMTP, no flag mutations. */
import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { vaultGet } from '../vault.js';
import { toMessage } from './client.js';
import type { MailMessage } from './types.js';

/** Separate credential capability: never load mail:password or SMTP configuration. */
export interface ReadMailAccount {
  address: string;
  password: string;
  imapHost: string;
  imapPort: number;
}

export async function loadReadMailAccount(
  get: (key: string) => Promise<string | null | undefined> = vaultGet,
): Promise<ReadMailAccount | null> {
  const address = (await get('mailRead:address'))?.trim();
  const password = await get('mailRead:password');
  if (!address || !password) return null;
  // Explicit Gmail-only route; no credential to arbitrary vault-configured hosts.
  if (!/^[^@\s]+@gmail\.com$/i.test(address))
    throw new Error('mailRead requiere una cuenta Gmail.');
  const compact = password.replace(/ /g, '');
  if (!/^[a-zA-Z]{16}$/.test(compact))
    throw new Error('mailRead requiere una contraseña de aplicación de 16 caracteres.');
  return {
    address,
    password: compact,
    imapHost: 'imap.gmail.com',
    imapPort: 993,
  };
}

export interface IdleCursor {
  validity: string;
  next: number;
}
export interface IdleMailbox {
  uidValidity: bigint;
  uidNext: number;
  readOnly?: boolean;
}
export interface IdleRow {
  uid: number;
  emailId?: string;
  internalDate?: Date | string;
  envelope?: {
    from?: Array<{ address?: string }>;
    to?: Array<{ address?: string }>;
    subject?: string;
    date?: Date;
  };
  source?: Buffer | string;
  flags?: Set<string>;
}
export interface IdleClient {
  capabilities: Map<string, unknown>;
  connect(): Promise<void>;
  mailboxOpen(folder: string, options: { readOnly: true }): Promise<IdleMailbox>;
  search(query: { uid: string }, options: { uid: true }): Promise<number[] | false>;
  fetchOne(
    uid: string,
    query: {
      uid: true;
      envelope: true;
      source: { maxLength: number };
      flags: true;
      internalDate: true;
    },
    options: { uid: true },
  ): Promise<IdleRow | false>;
  on(event: string, listener: () => void): unknown;
  close(): void;
  idle(): Promise<boolean>;
}
export interface IdleDeps {
  account: () => Promise<ReadMailAccount | null>;
  load: (scope: string) => IdleCursor | null;
  save: (scope: string, cursor: IdleCursor) => void;
  deliver: (messages: MailMessage[], scope: string) => Promise<void>;
  status: (state: 'connected' | 'retrying' | 'unconfigured' | 'unsupported' | 'stopped') => void;
  factory?: (account: ReadMailAccount) => IdleClient;
  now?: () => number;
}

export function idleScope(
  account: Pick<ReadMailAccount, 'address' | 'imapHost' | 'imapPort'>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([account.imapHost, account.imapPort, account.address.toLowerCase(), 'INBOX']),
    )
    .digest('hex');
}
/** On first setup/UIDVALIDITY reset, baseline at UIDNEXT: never replay a whole mailbox. */
export function reconcileCursor(saved: IdleCursor | null, mailbox: IdleMailbox): IdleCursor {
  const validity = String(mailbox.uidValidity);
  const next = mailbox.uidNext;
  if (!/^\d+$/.test(validity) || !Number.isSafeInteger(next) || next < 1)
    throw new Error('Invalid mailbox cursor');
  return saved &&
    saved.validity === validity &&
    Number.isSafeInteger(saved.next) &&
    saved.next > 0 &&
    saved.next <= next
    ? { ...saved }
    : { validity, next };
}

function defaultFactory(account: ReadMailAccount): IdleClient {
  return new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: true,
    auth: { user: account.address, pass: account.password },
    logger: false,
    disableAutoIdle: true,
    maxIdleTime: 25 * 60_000,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30 * 60_000,
  }) as unknown as IdleClient;
}

export class MailIdleTransport {
  private stopped = false;
  private client: IdleClient | null = null;
  private task: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private abort = new AbortController();
  private deps: IdleDeps;
  constructor(deps: IdleDeps) {
    this.deps = deps;
  }
  start(): void {
    if (!this.task && !this.stopped) this.task = this.run();
  }
  private async bounded<T>(work: Promise<T>): Promise<T> {
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]);
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.client?.close();
        reject(new Error('IMAP operation cancelled'));
      };
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  private wait(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.wake = done;
    });
  }
  private async run(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      let connectedAt: number | null = null;
      try {
        const account = await this.bounded(this.deps.account());
        if (!account) {
          this.deps.status('unconfigured');
          await this.wait(60 * 60_000);
          continue;
        }
        const client = (this.deps.factory ?? defaultFactory)(account);
        this.client = client;
        let dirty = false;
        let arrivalWake: () => void = () => {};
        let closed = false;
        let closeWake: () => void = () => {};
        const disconnect = new Promise<void>((resolve) => {
          closeWake = resolve;
        });
        client.on('exists', () => {
          dirty = true;
          arrivalWake();
        });
        client.on('close', () => {
          closed = true;
          closeWake();
        });
        client.on('error', () => {
          closed = true;
          closeWake();
          client.close();
        });
        await this.bounded(client.connect());
        // ImapFlow otherwise emulates IDLE with NOOP polling. Do not allow that.
        if (!client.capabilities.has('IDLE')) {
          this.deps.status('unsupported');
          return;
        }
        const mailbox = await this.bounded(client.mailboxOpen('INBOX', { readOnly: true }));
        if (mailbox.readOnly !== true) throw new Error('Mailbox is not read-only');
        const scope = idleScope(account);
        let cursor = reconcileCursor(this.deps.load(scope), mailbox);
        this.deps.save(scope, cursor);
        connectedAt = (this.deps.now ?? Date.now)();
        this.deps.status('connected');
        // Catch up missed arrivals by UID on reconnect, even if EXISTS count did not change.
        dirty = true;
        while (!this.stopped && !closed) {
          if (dirty) {
            dirty = false;
            // Re-open EXAMINE to verify UIDVALIDITY before interpreting any UID.
            const current = await this.bounded(client.mailboxOpen('INBOX', { readOnly: true }));
            if (current.readOnly !== true) throw new Error('Mailbox is not read-only');
            cursor = reconcileCursor(cursor, current);
            this.deps.save(scope, cursor);
            const boundary = current.uidNext - 1;
            if (boundary >= cursor.next) {
              const uids = await this.bounded(
                client.search({ uid: `${cursor.next}:${boundary}` }, { uid: true }),
              );
              if (!Array.isArray(uids)) throw new Error('IMAP search failed');
              // One bounded chunk per event cycle, continue backlog without polling new mail.
              const picked = [...new Set(uids)]
                .filter((u) => Number.isSafeInteger(u) && u >= cursor.next && u <= boundary)
                .sort((a, b) => a - b)
                .slice(0, 25);
              for (const uid of picked) {
                if (this.stopped || closed) break;
                const raw = await this.bounded(
                  client.fetchOne(
                    String(uid),
                    {
                      uid: true,
                      envelope: true,
                      source: { maxLength: 32_768 },
                      flags: true,
                      internalDate: true,
                    },
                    { uid: true },
                  ),
                );
                if (raw && raw.uid !== uid) throw new Error('UID mismatch');
                if (raw) {
                  const message = toMessage(raw, 'INBOX');
                  // Stable Gmail message ID survives UIDVALIDITY resets; fallback includes epoch.
                  message.id = raw.emailId
                    ? `object:${raw.emailId}`
                    : `uid:${cursor.validity}:${uid}`;
                  const receivedAt =
                    raw.internalDate instanceof Date
                      ? raw.internalDate.getTime()
                      : Date.parse(raw.internalDate ?? '');
                  if (Number.isFinite(receivedAt)) message.at = receivedAt;
                  await this.bounded(this.deps.deliver([message], scope));
                }
                // Cursor only advances after downstream durable acceptance, never before.
                cursor = { validity: cursor.validity, next: uid + 1 };
                this.deps.save(scope, cursor);
              }
              if (this.stopped || closed) throw new Error('IMAP interrupted during catch-up');
              if (picked.length === 25 && cursor.next <= boundary) {
                dirty = true;
                continue;
              }
              cursor = { validity: cursor.validity, next: boundary + 1 };
              this.deps.save(scope, cursor);
            }
          }
          if (this.stopped || closed) break;
          // IDLE maintenance once per 25 min; only EXISTS drives new reads.
          const idleAt = (this.deps.now ?? Date.now)();
          const arrival = new Promise<void>((resolve) => {
            arrivalWake = resolve;
          });
          if (!dirty) await Promise.race([client.idle(), disconnect, arrival]);
          arrivalWake = () => {};
          // Broken servers must not turn IDLE into an aggressive reconnect loop.
          if (!dirty && !closed && (this.deps.now ?? Date.now)() - idleAt < 1000)
            throw new Error('IDLE ended early');
        }
      } catch {
        /* No server text/passwords are logged. Status is deliberately generic. */
      } finally {
        this.client?.close();
        this.client = null;
      }
      // Una conexión que estuvo sana más de un minuto reinicia la espera, acabe
      // como acabe. Antes solo se reiniciaba si el bucle salía sin excepción: cada
      // corte que terminaba en error (timeout, IDLE cortado) sumaba un fallo y,
      // tras unos días de cortes normales, la reconexión esperaba hasta 64 min.
      if (connectedAt !== null && (this.deps.now ?? Date.now)() - connectedAt > 60_000)
        failures = 0;
      if (this.stopped) break;
      this.deps.status('retrying');
      await this.wait(Math.min(60 * 60_000, 30_000 * 2 ** Math.min(failures++, 7)));
    }
    this.deps.status('stopped');
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    this.wake?.();
    this.client?.close();
    await this.task;
  }
}
