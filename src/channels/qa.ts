import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type ApprovalChoice, TelegramChannel, type TelegramOptions } from './telegram.js';
import type { ChannelHandlers, Inbound, Outbound } from './types.js';

/**
 * Canal de QA: el mismo pipeline que Telegram (mismas herramientas, mismo gate,
 * mismo bucle de agente), pero con las conversaciones de prueba entrando por un
 * fichero y saliendo a otro. Solo existe con PA_QA_CHANNEL=1 en el entorno de la
 * sandbox; la instancia real nunca lo activa.
 *
 * Los chats de QA usan ids numericos a partir de QA_CHAT_BASE, muy por encima de
 * cualquier id real de Telegram, asi que lo que no sea QA sigue el camino normal y
 * el bot de Telegram de la sandbox sigue funcionando a la vez.
 *
 * Aprobaciones: se conceden solas salvo que la pregunta parezca de dinero. Los
 * pagos y compras se deniegan siempre: las pruebas nunca pagan nada real.
 */
export const QA_CHAT_BASE = 9_000_000_000_000;

export function isQaChatId(chatId: string | number): boolean {
  const n = Number(chatId);
  return Number.isFinite(n) && n >= QA_CHAT_BASE;
}

/**
 * Palabras de dinero (sobre texto sin tildes y en minusculas). Es una red de seguridad
 * encima de la lista blanca, no la defensa principal: ante la duda se deniega.
 */
const MONEY =
  /\b(pay\w*|paga\w*|pago\w*|purchas\w*|buy\w*|bought|checkout|subscri\w*|suscri\w*|compra\w*|tarjet\w*|card\w*|credit\w*|debit\w*|transfer\w*|bizum|paypal|factur\w*|invoice\w*|billing|iban|reserv\w*|book\w*|order\w*|pedid\w*|pedir|cobr\w*|charge\w*|euros?|eur|usd|gbp|dolar\w*|dollar\w*|libras?|glovo|uber|cabify|bolt|justeat|amazon|wallet|cripto\w*|crypto\w*|bitcoin|donat\w*|gift\w*)\b|[$\u00a3\u20ac]/;

/**
 * Herramientas que QA aprueba solas (lista blanca). Cualquier otra se deniega: lo no
 * reconocido nunca se aprueba. `shell`, `computer` y similares quedan fuera a proposito.
 */
export const QA_SAFE_TOOLS: ReadonlySet<string> = new Set([
  'download',
  'fetch',
  'read',
  'list',
  'memory',
  'opengym',
  'renfe',
  'browser',
  'skills',
  'done',
]);

function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Nombre de la herramienta de una pregunta de aprobacion ("¿Permito x?"), si lo hay. */
export function toolOfQuestion(question: string): string | null {
  const m = /^\u00bfPermito ([\w:.-]+)\?/.exec(question);
  return m?.[1] ?? null;
}

/** True si el texto habla de dinero. */
export function looksLikeMoney(call: { tool?: string } | null, question: string): boolean {
  return call?.tool === 'purchase' || MONEY.test(normalise(question));
}

/**
 * Decision de QA para una pregunta de aprobacion. Solo aprueba si se reconoce la
 * herramienta (o es la pregunta de dominio del navegador) Y no huele a dinero.
 */
export function qaApproves(question: string): boolean {
  if (looksLikeMoney(null, question)) return false;
  const tool = toolOfQuestion(question);
  if (tool) return QA_SAFE_TOOLS.has(tool.split(':')[0] ?? tool);
  return question.startsWith('\u00bfAbro ');
}

export interface QaOptions extends TelegramOptions {
  /** Carpeta con inbox.jsonl, outbox.jsonl y files/. */
  dir: string;
  /** Cada cuanto se mira el inbox. */
  pollMs?: number;
}

export class QaChannel extends TelegramChannel {
  readonly #dir: string;
  readonly #pollMs: number;
  readonly #chatByCase = new Map<string, string>();
  readonly #caseByChat = new Map<string, string>();
  #offset = 0;
  #timer: NodeJS.Timeout | null = null;
  #handlers: ChannelHandlers | null = null;
  #seq = 0;
  #fileSeq = 0;
  readonly #userId: string;

  constructor(options: QaOptions) {
    super(options);
    // Anti-activacion accidental: solo en un entorno marcado como sandbox y nunca en
    // Windows (la instancia real de Nico corre alli).
    if (process.platform === 'win32' || !existsSync(join(options.dir, 'SANDBOX'))) {
      throw new Error(
        `PA_QA_CHANNEL=1 rechazado: falta el fichero marcador ${join(options.dir, 'SANDBOX')} o es Windows`,
      );
    }
    this.#dir = options.dir;
    this.#pollMs = options.pollMs ?? 1_000;
    this.#userId = String(options.allowedUserIds[0] ?? 0);
    mkdirSync(join(this.#dir, 'files'), { recursive: true });
  }

  #out(chatId: string | number, rec: Record<string, unknown>): void {
    const id = String(chatId);
    appendFileSync(
      join(this.#dir, 'outbox.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), case: this.#caseByChat.get(id) ?? id, ...rec })}\n`,
    );
  }

  override async start(handlers: ChannelHandlers): Promise<void> {
    this.#handlers = handlers;
    const inbox = join(this.#dir, 'inbox.jsonl');
    if (!existsSync(inbox)) writeFileSync(inbox, '');
    // Empieza al final: lo que ya hubiera de una ejecucion anterior no se repite.
    this.#offset = statSync(inbox).size;
    this.#timer = setInterval(() => this.#poll(inbox), this.#pollMs);
    this.#timer.unref();
    handlers.log(
      'warn',
      'CANAL DE QA ACTIVO (PA_QA_CHANNEL=1): aprobaciones automaticas salvo dinero',
      {
        dir: this.#dir,
      },
    );
    await super.start(handlers);
  }

  #poll(inbox: string): void {
    const size = statSync(inbox).size;
    if (size <= this.#offset) return;
    const buf = readFileSync(inbox);
    const end = buf.lastIndexOf(0x0a) + 1;
    if (end <= this.#offset) return;
    const chunk = buf.subarray(this.#offset, end).toString('utf8');
    this.#offset = end;
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      let msg: { case?: string; text?: string };
      try {
        msg = JSON.parse(line) as { case?: string; text?: string };
      } catch {
        this.#handlers?.log('warn', 'qa inbox: linea mal formada ignorada', { chars: line.length });
        continue;
      }
      if (!msg.case || !msg.text) continue;
      let chatId = this.#chatByCase.get(msg.case);
      if (!chatId) {
        chatId = String(QA_CHAT_BASE + ++this.#seq);
        this.#chatByCase.set(msg.case, chatId);
        this.#caseByChat.set(chatId, msg.case);
      }
      const inbound: Inbound = {
        channel: this.name,
        account: this.account,
        chatId,
        userId: this.#userId,
        displayName: 'qa',
        text: msg.text,
        authorised: true,
        messageId: String(1_000 + ++this.#fileSeq),
        receivedAt: new Date().toISOString(),
      };
      this.#out(chatId, { kind: 'in', text: msg.text });
      void Promise.resolve(this.#handlers?.onMessage(inbound)).catch((err: unknown) => {
        this.#out(chatId, {
          kind: 'error',
          text: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  override isReady(): boolean {
    return super.isReady();
  }

  override async send(outbound: Outbound): Promise<string | null> {
    if (!isQaChatId(outbound.chatId)) return super.send(outbound);
    this.#out(outbound.chatId, {
      kind: 'text',
      text: outbound.text,
      buttons: outbound.buttons?.map((b) => b.label),
      hasImages: outbound.images?.length ?? 0,
      hasAudio: Boolean(outbound.audio),
    });
    return String(1_000_000 + ++this.#fileSeq);
  }

  #saveFile(chatId: string | number, name: string, bytes: Buffer, kind: string): void {
    const file = `${this.#caseByChat.get(String(chatId)) ?? chatId}-${++this.#fileSeq}-${name}`;
    writeFileSync(join(this.#dir, 'files', file), bytes);
    this.#out(chatId, { kind, file, bytes: bytes.length });
  }

  override async sendPhotoBytes(
    chatId: number,
    bytes: Buffer,
    threadId?: string,
    size?: { width: number; height: number },
  ): Promise<string | null> {
    if (!isQaChatId(chatId)) return super.sendPhotoBytes(chatId, bytes, threadId, size);
    this.#saveFile(chatId, 'foto.png', bytes, 'photo');
    return String(1_000_000 + ++this.#fileSeq);
  }

  override async sendVoiceBytes(
    chatId: number,
    bytes: Buffer,
    threadId: string | undefined,
    seconds: number,
  ): Promise<void> {
    if (!isQaChatId(chatId)) return super.sendVoiceBytes(chatId, bytes, threadId, seconds);
    this.#saveFile(chatId, 'voz.ogg', bytes, 'voice');
  }

  override async sendVideo(
    chatId: number,
    bytes: Buffer,
    durationSeconds: number,
    caption: string,
  ): Promise<void> {
    if (!isQaChatId(chatId)) return super.sendVideo(chatId, bytes, durationSeconds, caption);
    this.#saveFile(chatId, 'video.mp4', bytes, 'video');
  }

  override async sendDocumentBytes(
    chatId: number,
    bytes: Buffer,
    filename: string,
    caption: string,
    threadId?: string,
  ): Promise<void> {
    if (!isQaChatId(chatId)) {
      return super.sendDocumentBytes(chatId, bytes, filename, caption, threadId);
    }
    this.#saveFile(chatId, filename.replace(/[^\w.-]+/g, '_'), bytes, 'document');
  }

  override async editPhoto(chatId: string, messageId: string, bytes: Buffer): Promise<void> {
    if (!isQaChatId(chatId)) return super.editPhoto(chatId, messageId, bytes);
  }

  override async editMessageText(chatId: string, messageId: string, text: string): Promise<void> {
    if (!isQaChatId(chatId)) return super.editMessageText(chatId, messageId, text);
    this.#out(chatId, { kind: 'edit', text });
  }

  override async deleteMessage(chatId: string, messageId: string): Promise<void> {
    if (!isQaChatId(chatId)) return super.deleteMessage(chatId, messageId);
  }

  override async action(
    chatId: string,
    action:
      | 'typing'
      | 'upload_photo'
      | 'upload_voice'
      | 'upload_video'
      | 'upload_document' = 'typing',
  ): Promise<void> {
    if (!isQaChatId(chatId)) return super.action(chatId, action);
    this.#out(chatId, { kind: 'action', action });
  }

  override async downloadFile(fileId: string, limitBytes?: number): Promise<Buffer | null> {
    if (fileId.startsWith('qa:')) return null;
    return super.downloadFile(fileId, limitBytes);
  }

  override offerApproval(
    id: string,
    chatId: string,
    question: string,
    opts?: { askScope?: boolean },
  ): Promise<ApprovalChoice> {
    if (!isQaChatId(chatId)) return super.offerApproval(id, chatId, question, opts);
    const approved = qaApproves(question);
    this.#out(chatId, { kind: 'approval', question, approved });
    return Promise.resolve({ approved, scope: 'once' });
  }

  override async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await super.stop();
  }
}
