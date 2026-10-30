/**
 * Arranque del canal de correo (F10) para el daemon: decide si se registra y
 * con que cuentas. Apagado salvo PA_CORREO_CANAL=1; sin lista de remitentes o
 * sin cuentas de lectura/envio no se registra y dice por que.
 */

import { join } from 'node:path';
import type { ReadMailAccount } from '../mail/idle.js';
import type { MailAccount, SendRequest, SendResult } from '../mail/types.js';
import {
  type EmailAuditEvent,
  EmailChannel,
  emailChannelConfig,
  emailChannelEnabled,
  type RawCommandMail,
} from './email.js';

export interface EmailSetupDeps {
  env?: NodeJS.ProcessEnv;
  stateDir: string;
  loadRead(): Promise<ReadMailAccount | null>;
  loadSend(): Promise<MailAccount | null>;
  send(account: MailAccount, req: SendRequest): Promise<SendResult>;
  poll(account: ReadMailAccount, cursorFile: string): Promise<RawCommandMail[]>;
  audit(event: EmailAuditEvent): void;
}

export async function setupEmailChannel(
  deps: EmailSetupDeps,
): Promise<{ channel: EmailChannel } | { channel: null; reason: string }> {
  const env = deps.env ?? process.env;
  if (!emailChannelEnabled(env)) return { channel: null, reason: 'apagado (PA_CORREO_CANAL)' };
  const config = emailChannelConfig(env);
  if (config.allow.length === 0) {
    return { channel: null, reason: 'PA_CORREO_CANAL_REMITENTES vacío: nadie puede escribir' };
  }
  const read = await deps.loadRead().catch(() => null);
  const send = await deps.loadSend().catch(() => null);
  if (!read || !send)
    return { channel: null, reason: 'faltan las cuentas de correo (lectura y envío)' };
  const cursorFile = join(deps.stateDir, 'correo-canal.json');
  const channel = new EmailChannel(read.address, {
    config,
    poll: () => deps.poll(read, cursorFile),
    send: (req) => deps.send(send, req),
    audit: deps.audit,
  });
  return { channel };
}
