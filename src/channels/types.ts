/**
 * Channel abstraction.
 *
 * One normalized inbound/outbound shape so adding a transport is a self-contained
 * file. Modelled on how real always-on agents key state: a chat is identified by
 * (channel, account, chatId, threadId) and everything per-chat — permissions,
 * memory, active session — hangs off that key.
 *
 * Two rules that are easy to get wrong and expensive to debug:
 *
 * 1. `Inbound.authorised` is decided by the adapter, never assumed by the agent.
 *    With computer use behind the channel, "anyone who messages the bot" would
 *    mean "anyone who messages the bot can move your mouse".
 * 2. Adapters own sockets; the agent only sees messages. That separation is what
 *    lets a hot reload swap the agent without dropping the transport, and dropping
 *    a WhatsApp session is how you get logged out.
 */
export interface Inbound {
  channel: string;
  /** Stable per-channel account id, so one process can serve several. */
  account: string;
  chatId: string;
  /** Telegram forum topic, Discord thread, etc. */
  threadId?: string;
  userId: string;
  /** Human-readable name, for logs and for addressing. */
  displayName?: string;
  text: string;
  images?: ChannelImage[];
  /**
   * Telegram photo to fetch lazily inside the turn. Downloading on arrival
   * reordered messages behind a slow download and let a hung fetch stall the
   * chat before it was even queued.
   */
  photoFileId?: string;
  /**
   * Voice note or audio file, also fetched lazily. Telegram voice notes are
   * ogg/opus at 16-48kbps; the mime type matters because the transcriber only
   * accepts what it can actually decode, and silently mis-decoding mp3 as opus
   * produces a confident, wrong transcript.
   */
  audioFileId?: string;
  audioMimeType?: string;
  audioDurationSeconds?: number;
  /**
   * A forwarded document (PDF, text file, ...), also fetched lazily: the bytes
   * feed the document memory, and downloading on arrival would reorder
   * messages behind a slow fetch exactly like photos would.
   */
  documentFileId?: string;
  documentMimeType?: string;
  documentName?: string;
  /** Set by the adapter after its own auth check. */
  authorised: boolean;
  replyToMessageId?: string;
  /** Chat metadata the adapter can supply: is this a group? */
  isGroup?: boolean;
  messageId: string;
  receivedAt: string;
}

/**
 * An image as the harness models it. The `type: 'image'` discriminant is required
 * by pi-ai's ImageContent, so inbound images carry it from the transport all the
 * way to the agent prompt rather than being reshaped on arrival.
 */
/**
 * An image as the harness models it. The `type: 'image'` discriminant is required
 * by pi-ai's ImageContent, so inbound images carry it from the transport all the
 * way to the agent prompt rather than being reshaped on arrival.
 */
export interface ChannelImage {
  type: 'image';
  mimeType: string;
  data: string;
}

/** A voice note or audio file. Transcoded before it reaches the model. */
export interface ChannelAudio {
  mimeType: string;
  data: string;
  /** Seconds, when the transport reports it. */
  durationSeconds?: number;
}

export interface Outbound {
  channel: string;
  account: string;
  chatId: string;
  threadId?: string;
  text: string;
  images?: ChannelImage[];
  /**
   * Audio reply. Transports that can send a real voice note (Telegram needs
   * ogg/opus) should; the rest send it as an audio file. Optional on purpose: the
   * text is always present, so a synthesiser failure degrades to a text-only
   * message instead of losing the answer.
   */
  audio?: ChannelAudio;
  /**
   * Inline buttons. `action` is the opaque callback payload the adapter resolves and
   * must encode the decision itself (`approve:<id>` / `deny:<id>`), so there is
   * exactly one place that decides approve vs deny. Adapters must not rewrite it.
   */
  buttons?: Array<{ label: string; action: string }>;
  replyToMessageId?: string;
}

/** Asks the human a question and resolves with the answer, or null on timeout. */
export type Prompter = (
  inbound: Inbound,
  question: string,
  timeoutMs: number,
) => Promise<boolean | null>;

export interface ChannelAdapter {
  readonly name: string;
  readonly account: string;
  /** Start listening. Must be safe to call once per process. */
  start(handlers: ChannelHandlers): Promise<void>;
  /**
   * Send one outbound message. Implementations return the id of the message they
   * created when the transport has one, because that id is the only handle a later
   * reply can be attached to — and attaching the answer to the message it answers
   * is what makes several concurrent conversations legible in one chat.
   */
  send(outbound: Outbound): Promise<string | null>;
  stop(strict?: boolean): Promise<void>;
  /** Optional: true once the transport is authenticated and connected. */
  isReady(): boolean;
}

export interface ChannelHandlers {
  onMessage(inbound: Inbound): void | Promise<void>;
  /**
   * The channel's polling died and it is reconnecting on its own. Fired once
   * per outage, like the wake listener's notice: the failure repeats until
   * fixed, so the message must not.
   */
  onPollingLost?(channel: string, message: string): void | Promise<void>;
  /** Polling is back after an onPollingLost. */
  onPollingRecovered?(channel: string): void | Promise<void>;
  /**
   * Approval requests arrive here regardless of which chat asked, so the human can
   * approve from the channel they happen to be looking at.
   */
  onApprovalNeeded?(request: ApprovalRequest): void | Promise<void>;
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    fields?: Record<string, unknown>,
  ): void;
}

export interface ApprovalRequest {
  id: string;
  /** Where the request came from, so the approval can be sent back there. */
  origin: Inbound;
  tool: string;
  reason: string;
  /** Never contains raw secrets: the gate redacts before building this. */
  summary: string;
  expiresAt: string;
  resolve(approved: boolean): void;
}

/** Key for per-chat state: permissions, memory scope, active session. */
export function chatKey(
  inbound: Pick<Inbound, 'channel' | 'account' | 'chatId' | 'threadId'>,
): string {
  const parts = [inbound.channel, inbound.account, inbound.chatId];
  if (inbound.threadId) parts.push(inbound.threadId);
  return parts.join(':');
}
