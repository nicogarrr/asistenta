import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { log } from '../log.js';
import {
  listFolders,
  loadAccount,
  markSeen,
  readMail,
  searchMail,
  sendMail,
} from '../mail/client.js';
import type { MailMessage } from '../mail/types.js';

/**
 * The mailbox, in the agent's hands and out of the model's.
 *
 * The whole shape of this tool follows from one rule: the thing that unlocks the
 * account is not the model's business. It lives in the vault, is read at the moment
 * of use, and no action here returns it — not in `content`, not in `details`, not in
 * an error message. The model gets senders, subjects and bodies, which is what it
 * needs to answer "¿qué correos tengo?" and nothing more.
 *
 * Sending is the one action that reaches another person, so it goes through
 * `requireApproval` before anything is queued. Everything else is reading, and reading
 * your own mail is not something to ask permission for.
 */

const MailParams = Type.Object({
  action: Type.Union([
    Type.Literal('list'),
    Type.Literal('search'),
    Type.Literal('read'),
    Type.Literal('send'),
    Type.Literal('mark_seen'),
    Type.Literal('folders'),
  ]),
  limit: Type.Optional(Type.Number({ description: 'For list/search: how many, max 50. Default 10.' })),
  id: Type.Optional(Type.String({ description: 'For read and mark_seen: the message id from list/search.' })),
  from: Type.Optional(Type.String({ description: 'For search: sender.' })),
  subject: Type.Optional(Type.String({ description: 'For search: subject contains.' })),
  q: Type.Optional(Type.String({ description: 'For search: free text over subject and body.' })),
  sinceHours: Type.Optional(Type.Number({ description: 'For search: only messages from the last N hours.' })),
  unreadOnly: Type.Optional(Type.Boolean({ description: 'For search/list: only unread.' })),
  to: Type.Optional(Type.String({ description: 'For send: comma separated recipients.' })),
  text: Type.Optional(Type.String({ description: 'For send: the body.' })),
});

export interface MailToolDeps {
  client?: {
    search: typeof searchMail;
    read: typeof readMail;
    markSeen: typeof markSeen;
    send: typeof sendMail;
    folders: typeof listFolders;
    loadAccount: typeof loadAccount;
  };
  /** Returns true when the human approved the send. Always called before sending. */
  requireApproval: (action: string, summary: string) => Promise<boolean>;
}

function ok(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: 'text' as const, text }], details };
}

/** One message as the model should read it: who, when, what about, and the body. */
function formatMessage(message: MailMessage): string {
  const when = message.at ? new Date(message.at).toISOString().slice(0, 16).replace('T', ' ') : 'fecha desconocida';
  return [
    `De: ${message.from || '(desconocido)'}`,
    `Asunto: ${message.subject}`,
    `Fecha: ${when}${message.seen ? '' : ' · sin leer'}`,
    '',
    message.text.slice(0, 1500) || '(sin cuerpo)',
  ].join('\n');
}

export function createMailTool(deps: MailToolDeps): AgentTool<typeof MailParams> {
  const client = deps.client ?? {
    search: searchMail,
    read: readMail,
    markSeen,
    send: sendMail,
    folders: listFolders,
    loadAccount,
  };

  return {
    name: 'mail',
    label: 'Correo',
    description: [
      'Read and send email on the user\'s own account.',
      '',
      'action=list shows the newest mail. action=search filters by from/subject/q/sinceHours/',
      'unreadOnly. action=read fetches one message by id. action=mark_seen marks it read.',
      'action=folders lists the mailboxes.',
      '',
      'action=send writes and sends a message. It ALWAYS asks the user first, and you must',
      'report the outcome honestly: say it was sent only when the result says ok. Never say',
      'you sent something you did not.',
      '',
      'Credentials are not yours to handle. Do not ask for a password, do not try to read the',
      'account configuration, and if a message body happens to contain a password, do not',
      'quote it back.',
    ].join('\n'),
    parameters: MailParams,
    // Sequential: one mailbox, one connection at a time. Two searches at once would
    // open two IMAP sessions and get one of them dropped by the server.
    executionMode: 'sequential',
    execute: async (_id, args) => {
      const account = await client.loadAccount();
      if (!account) {
        return ok(
          'El correo no está configurado. Necesito que guardes la contraseña de aplicación ' +
            'en el vault: `pa vault set mail:password <clave>`. La dirección ya la tengo.',
          { configured: false },
        );
      }

      const limit = Math.max(1, Math.min(50, Math.trunc(Number(args.limit ?? 10))));

      switch (args.action) {
        case 'list':
        case 'search': {
          const since = args.sinceHours ? Date.now() - args.sinceHours * 3_600_000 : undefined;
          const found = await client.search(
            account,
            {
              from: args.from,
              subject: args.subject,
              q: args.q,
              since,
              unreadOnly: args.unreadOnly,
            },
            limit,
          );
          if (!found.length) return ok('No hay correos que coincidan.', { count: 0 });
          const lines = found.map(
            (m, i) =>
              `${i + 1}. ${m.from || '(?)'} — ${m.subject}` +
              `${m.at ? ` (${new Date(m.at).toISOString().slice(0, 10)})` : ''}` +
              `${m.seen ? '' : ' · sin leer'}`,
          );
          return ok(`Correos (${found.length}):\n${lines.join('\n')}`, {
            count: found.length,
            ids: found.map((m) => m.id),
          });
        }

        case 'read': {
          const id = String(args.id ?? '');
          if (!id) throw new Error('la acción read necesita id');
          const message = await client.read(account, id);
          if (!message) return ok('No encuentro ese correo.', { found: false });
          return ok(formatMessage(message), { found: true, from: message.from, seen: message.seen });
        }

        case 'mark_seen': {
          const id = String(args.id ?? '');
          if (!id) throw new Error('la acción mark_seen necesita id');
          await client.markSeen(account, id);
          return ok('Marcado como leído.', { id });
        }

        case 'folders': {
          const folders = await client.folders(account);
          return ok(`Carpetas: ${folders.join(', ')}`, { folders });
        }

        case 'send': {
          const to = String(args.to ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          const subject = String(args.subject ?? '');
          const text = String(args.text ?? '');
          if (!to.length) throw new Error('la acción send necesita destinatario');

          // The summary is deliberately the subject and the recipients, never the
          // body: a confirmation dialog is not the place to paste the whole email.
          const approved = await deps.requireApproval('mail:send', `Enviar "${subject}" a ${to.join(', ')}`);
          if (!approved) {
            return ok('No enviado: no lo has aprobado.', { sent: false, approved: false });
          }

          const result = await client.send(account, { to, subject, text });
          if (!result.ok) {
            log.warn('mail tool send failed', { error: result.error });
            return ok(`No he podido enviarlo: ${result.error ?? 'error desconocido'}`, {
              sent: false,
              approved: true,
            });
          }
          return ok(`Enviado a ${to.join(', ')}.`, { sent: true, approved: true, id: result.id });
        }

        default:
          throw new Error(`acción desconocida: ${String(args.action)}`);
      }
    },
  };
}
