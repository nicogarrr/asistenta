/**
 * Correo como canal de conversacion (F10). APAGADO por defecto
 * (PA_CORREO_CANAL=1). Solo el dueño: un correo entra como turno unicamente si
 *   1. el asunto lleva la etiqueta «[asistenta]»,
 *   2. el From es UNA direccion de la lista PA_CORREO_CANAL_REMITENTES, y
 *   3. la cabecera Authentication-Results que añadio NUESTRO servidor (la
 *      primera cuyo authserv-id es PA_CORREO_CANAL_AUTHSERV, por defecto
 *      mx.google.com) dice dkim=pass con header.d alineado con el dominio del
 *      From. Las cabeceras Authentication-Results que trae el propio correo
 *      (mas abajo, puestas por quien lo envia) no cuentan: se pueden falsificar.
 * Lo demas se ignora y se audita con el motivo. La respuesta va en el mismo
 * hilo (In-Reply-To/References). Las aprobaciones NUNCA van por correo: el
 * adaptador quita los botones y remite a Telegram. Un turno que entra por
 * correo cuenta como contenido externo (fuente «correo») para la puerta.
 */

import type { SendRequest, SendResult } from '../mail/types.js';
import type { ChannelAdapter, ChannelHandlers, Inbound, Outbound } from './types.js';

export const EMAIL_CHANNEL = 'correo';
export const EMAIL_SUBJECT_TAG = '[asistenta]';
export const EMAIL_TAINT_SOURCE = 'correo';

/** Lo mínimo del Gate que necesita un turno que entra por correo. */
export interface EmailTurnGate {
  markTainted(sessionId: string, source: string): void;
  taintSessionPrivate(sessionId: string, source: string): void;
}

/**
 * Marca un turno que entra por correo antes de correr el agente. El cuerpo del
 * correo va al prompt sin pasar por una herramienta, así que hay que marcar las
 * dos cosas a mano: es externo (lo escribe un tercero → lo que no sea lectura
 * pregunta, F2) y es privado (es tu buzón → una salida a la red con datos
 * pregunta, #376/#492). Solo endurece.
 */
export function taintEmailTurn(gate: EmailTurnGate, sessionId: string): void {
  gate.markTainted(sessionId, EMAIL_TAINT_SOURCE);
  gate.taintSessionPrivate(sessionId, 'el correo que inició este turno');
}
export const EMAIL_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_AUTHSERV = 'mx.google.com';
const MAX_TEXT = 8_000;

export interface EmailChannelConfig {
  allow: string[];
  authserv: string;
}

export function emailChannelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PA_CORREO_CANAL === '1';
}

export function emailChannelConfig(env: NodeJS.ProcessEnv = process.env): EmailChannelConfig {
  const allow = (env.PA_CORREO_CANAL_REMITENTES ?? '')
    .split(/[,;\s]+/)
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
  const authserv = (env.PA_CORREO_CANAL_AUTHSERV ?? '').trim().toLowerCase() || DEFAULT_AUTHSERV;
  return { allow, authserv };
}

/** Un correo tal y como lo lee el buzon (cabeceras en crudo, en orden). */
export interface RawCommandMail {
  uid: string;
  /** Cabeceras completas, en el orden del mensaje (la primera es la mas reciente). */
  headers: string;
  text: string;
  /** Tamaño total del mensaje en bytes. */
  size: number;
}

export interface AcceptedMail {
  ok: true;
  from: string;
  subject: string;
  text: string;
  messageId: string | null;
  references: string[];
}

export interface RejectedMail {
  ok: false;
  reason: string;
  /**
   * Solo cuando el remitente YA está verificado (lista + dkim=pass) y el correo
   * se descarta por tamaño: a quién avisar en el mismo hilo. A un remitente sin
   * verificar nunca se le contesta (sería rebote a una dirección falsificada).
   */
  notify?: AcceptedMail;
}

/** Aviso al remitente verificado cuyo correo se ha descartado por tamaño. */
export const EMAIL_TOO_BIG_TEXT =
  'Tu correo pesa más de 5 MB (seguramente por un adjunto) y no lo he leído. Mándame la petición en un correo sin adjuntos grandes, o compárteme un enlace al fichero.';

/** Cabeceras desplegadas (lineas de continuacion unidas), en orden. */
export function parseHeaders(raw: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const line of raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    out.push({ name: line.slice(0, i).trim().toLowerCase(), value: line.slice(i + 1).trim() });
  }
  return out;
}

const header = (hs: Array<{ name: string; value: string }>, name: string): string[] =>
  hs.filter((h) => h.name === name).map((h) => h.value);

/** La direccion de un From con exactamente un buzon; si no, null. */
export function singleAddress(from: string): string | null {
  const angle = [...from.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)];
  if (angle.length > 1) return null;
  if (angle.length === 1) {
    const outside = from.replace(/"[^"]*"/g, '').replace(/<[^<>]*>/g, '');
    if (outside.includes('@') || outside.includes(',')) return null;
    return (angle[0]?.[1] ?? '').toLowerCase();
  }
  const bare = from.trim();
  return /^[^@\s,<>]+@[^@\s,<>]+$/.test(bare) ? bare.toLowerCase() : null;
}

/**
 * dkim=pass alineado en la cabecera de NUESTRO servidor: la primera
 * Authentication-Results cuyo authserv-id es `authserv`. Si la primera
 * cabecera de ese servidor no dice pass, no se busca otra mas abajo.
 */
export function dkimPassFor(
  hs: Array<{ name: string; value: string }>,
  domain: string,
  authserv: string,
): boolean {
  const ours = header(hs, 'authentication-results').find(
    (v) => (v.split(';')[0] ?? '').trim().split(/\s+/)[0]?.toLowerCase() === authserv,
  );
  if (!ours) return false;
  const d = domain.toLowerCase();
  for (const part of ours.split(';').slice(1)) {
    const m = /^\s*dkim\s*=\s*(\w+)/i.exec(part);
    if (!m || m[1]?.toLowerCase() !== 'pass') continue;
    const signer = /header\.(?:d|i)\s*=\s*@?([^\s;]+)/i.exec(part)?.[1]?.toLowerCase();
    if (!signer) continue;
    const sd = signer.includes('@') ? (signer.split('@')[1] ?? '') : signer;
    if (d === sd || d.endsWith(`.${sd}`)) return true;
  }
  return false;
}

const ids = (s: string): string[] =>
  s.match(/<[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+>/g) ?? [];

/** Quita la cita del correo anterior («> …», «El … escribió:», firma «-- »). */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*(El|On)\s.+(escribió|wrote):\s*$/i.test(line)) break;
    if (/^-- ?$/.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

export function verifyCommandMail(
  mail: RawCommandMail,
  cfg: EmailChannelConfig,
): AcceptedMail | RejectedMail {
  const hs = parseHeaders(mail.headers);
  const subject = header(hs, 'subject')[0] ?? '';
  if (!subject.toLowerCase().includes(EMAIL_SUBJECT_TAG))
    return { ok: false, reason: 'sin etiqueta [asistenta]' };
  const froms = header(hs, 'from');
  const from = froms.length === 1 ? singleAddress(froms[0] ?? '') : null;
  if (!from) return { ok: false, reason: 'From ausente, repetido o con varias direcciones' };
  if (!cfg.allow.includes(from))
    return { ok: false, reason: `remitente fuera de la lista: ${from}` };
  const domain = from.split('@')[1] ?? '';
  if (!dkimPassFor(hs, domain, cfg.authserv)) {
    return { ok: false, reason: `sin dkim=pass de ${cfg.authserv} para ${domain}` };
  }
  const mid = header(hs, 'message-id');
  const messageId =
    mid.length === 1 && ids(mid[0] ?? '').length === 1 ? (ids(mid[0] ?? '')[0] ?? null) : null;
  const references = [...new Set(ids(header(hs, 'references').join(' ')))].slice(-20);
  if (mail.size > EMAIL_MAX_BYTES) {
    return {
      ok: false,
      reason: 'correo de más de 5 MB',
      notify: { ok: true, from, subject, text: '', messageId, references },
    };
  }
  const text = stripQuoted(mail.text).slice(0, MAX_TEXT);
  if (!text) return { ok: false, reason: 'correo sin texto' };
  return { ok: true, from, subject, text, messageId, references };
}

/** La respuesta en el mismo hilo. */
export function replyRequest(to: AcceptedMail, text: string): SendRequest {
  const subject = /^re:/i.test(to.subject) ? to.subject : `Re: ${to.subject}`;
  const refs = to.messageId ? [...to.references, to.messageId].slice(-20) : to.references;
  return {
    to: [to.from],
    subject,
    text,
    ...(to.messageId ? { inReplyTo: to.messageId } : {}),
    ...(refs.length > 0 ? { references: refs } : {}),
  };
}

export type EmailAuditEvent = {
  uid: string;
  accepted: boolean;
  reason?: string;
  /** Correo descartado por tamaño: si el aviso al remitente verificado salió. */
  notified?: boolean;
};

/**
 * Lo ignorado va al registro de auditoría (`pa auditoria`), no solo al log:
 * es la única huella de que alguien intentó mandar órdenes por correo.
 */
export function emailAuditRecord(e: EmailAuditEvent): {
  actor: string;
  action: string;
  target: string;
  result: 'blocked';
  detail: string;
} {
  const detail = e.reason ?? 'ignorado';
  return {
    actor: EMAIL_CHANNEL,
    action: 'correo.ignorado',
    target: `uid:${e.uid}`,
    result: 'blocked',
    detail:
      e.notified === undefined
        ? detail
        : `${detail}; aviso al remitente ${e.notified ? 'enviado' : 'NO enviado'}`,
  };
}

export interface EmailChannelDeps {
  config: EmailChannelConfig;
  /** Correos nuevos desde la ultima llamada (el buzon recuerda su cursor). */
  poll(): Promise<RawCommandMail[]>;
  send(req: SendRequest): Promise<SendResult>;
  /** Registro de auditoria de lo ignorado. */
  audit(event: EmailAuditEvent): void;
  intervalMs?: number;
  now?: () => Date;
}

export const EMAIL_APPROVAL_NOTE =
  'Esto necesita tu aprobación: te la he mandado por Telegram (las aprobaciones nunca van por correo).';

/**
 * Adaptador de canal. Cada correo aceptado es un hilo propio: chatId
 * «correo:<remitente>», threadId = Message-ID del correo, y la respuesta se
 * engancha a ese correo.
 */
export class EmailChannel implements ChannelAdapter {
  readonly name = EMAIL_CHANNEL;
  readonly account: string;
  readonly #deps: EmailChannelDeps;
  readonly #threads = new Map<string, AcceptedMail>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #handlers: ChannelHandlers | null = null;
  #polling = false;

  constructor(account: string, deps: EmailChannelDeps) {
    this.account = account;
    this.#deps = deps;
  }

  async start(handlers: ChannelHandlers): Promise<void> {
    this.#handlers = handlers;
    await this.pollOnce();
    this.#timer = setInterval(() => void this.pollOnce(), this.#deps.intervalMs ?? 60_000);
    this.#timer.unref?.();
  }

  /** Una pasada por el buzon; devuelve cuantos correos entraron como turno. */
  async pollOnce(): Promise<number> {
    if (this.#polling || !this.#handlers) return 0;
    this.#polling = true;
    let accepted = 0;
    try {
      for (const raw of await this.#deps.poll()) {
        const v = verifyCommandMail(raw, this.#deps.config);
        if (!v.ok) {
          if (v.notify) {
            const r = await this.#deps
              .send(replyRequest(v.notify, EMAIL_TOO_BIG_TEXT))
              .catch(() => ({ ok: false }) as SendResult);
            this.#deps.audit({ uid: raw.uid, accepted: false, reason: v.reason, notified: r.ok });
          } else {
            this.#deps.audit({ uid: raw.uid, accepted: false, reason: v.reason });
          }
          continue;
        }
        this.#deps.audit({ uid: raw.uid, accepted: true });
        const messageId = v.messageId ?? `uid:${raw.uid}`;
        this.#threads.set(messageId, v);
        const inbound: Inbound = {
          channel: EMAIL_CHANNEL,
          account: this.account,
          chatId: `${EMAIL_CHANNEL}:${v.from}`,
          threadId: messageId,
          userId: v.from,
          text: v.text,
          authorised: true,
          messageId,
          receivedAt: (this.#deps.now?.() ?? new Date()).toISOString(),
        };
        accepted++;
        await this.#handlers.onMessage(inbound);
      }
    } finally {
      this.#polling = false;
    }
    return accepted;
  }

  async send(outbound: Outbound): Promise<string | null> {
    const key = outbound.replyToMessageId ?? outbound.threadId;
    const to = key ? this.#threads.get(key) : undefined;
    if (!to) return null;
    const text = outbound.buttons?.length
      ? `${outbound.text}\n\n${EMAIL_APPROVAL_NOTE}`
      : outbound.text;
    const r = await this.#deps.send(replyRequest(to, text));
    return r.ok ? (r.id ?? null) : null;
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#handlers = null;
  }

  isReady(): boolean {
    return this.#handlers !== null;
  }
}
