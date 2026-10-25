import { Bot, type Context, GrammyError, HttpError, InlineKeyboard, InputFile } from 'grammy';
import { log, redact } from '../log.js';
import { Mutex, withTimeout } from '../utils.js';
import { TELEGRAM_COMMANDS } from './telegram-commands.js';
import type { ChannelAdapter, ChannelAudio, ChannelHandlers, Inbound, Outbound } from './types.js';

/**
 * Telegram adapter.
 *
 * Telegram is the primary channel on purpose. It is the only major messenger with
 * a first-class bot platform: no business verification, free, and its UI primitives
 * (inline buttons, ephemeral group messages, editable drafts) map directly onto the
 * approval flow this agent needs. WhatsApp's Business Platform terms have prohibited
 * general-purpose AI assistants since January 2026, and unofficial clients get
 * accounts banned, so it is not worth the risk here.
 *
 * Long polling only: no public URL and no webhook, so the daemon is not reachable
 * from the network at all.
 *
 * Privacy is the allowlist, full stop. Telegram has no "private bot" switch — any
 * account that finds the username can message it — so the adapter refuses everyone
 * whose numeric id is not listed. Those ids are attested by Telegram's servers on
 * every update and cannot be forged through the Bot API, which is what makes an
 * allowlist sufficient here without a second ceremony.
 */
export interface TelegramOptions {
  token: string;
  /** Telegram numeric user ids allowed to talk to the agent. */
  allowedUserIds: number[];
  account?: string;
  /** How long an approval stays answerable. */
  approvalTtlMs?: number;
}

/**
 * How wide one human approval is. Mirrors `ApprovalScope` in permissions.ts — the
 * channel only reports what the human picked with the buttons, the gate is the
 * one that applies it — so the two unions must stay identical.
 */
export type ApprovalScope = 'once' | 'session' | 'always';

/** The human's answer to one approval prompt, with the scope they chose. */
export interface ApprovalChoice {
  approved: boolean;
  scope: ApprovalScope;
}

/**
 * Minimum spacing between outbound calls, process-wide.
 *
 * The documented guidance is "in a single chat, avoid sending more than one message
 * per second", with short bursts tolerated. 1100ms keeps a steady stream just inside
 * the safe side of that, and being one global number rather than one per chat is
 * deliberate: Telegram warns that parallel requests at a throttled peer lengthen the
 * cooldown, and this adapter now answers several conversations at once.
 */
const MIN_GAP_MS = 1_100;
/** Un envío no puede reintentarse para siempre: un endpoint muerto congelaría todos los chats. */
const SEND_MAX_ATTEMPTS = 4;
const SEND_MAX_TOTAL_MS = 90_000;

/** Single gate key: the limiter is process-wide, not per chat. */
const GLOBAL_KEY = 'global';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

function describeError(err: unknown): string {
  if (err instanceof GrammyError) return `${err.error_code} ${err.description}`;
  if (err instanceof HttpError) return `http transport error: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * How long to wait before retrying a failed send, or null when retrying cannot help.
 *
 * A 4xx from Telegram is permanent (bad chat id, thread not found, message too old)
 * and retrying it just burns the rate budget and delays the error. A 429 carries an
 * explicit `retry_after` that must be obeyed exactly, without adding slack of our
 * own. Everything else is transient.
 */
export function backoffFor(err: unknown, attempt: number): number | null {
  if (err instanceof GrammyError) {
    if (err.error_code === 429) {
      const retryAfter = (err as { parameters?: { retry_after?: number } }).parameters?.retry_after;
      return Math.max(1_000, (retryAfter ?? 1) * 1_000);
    }
    if (err.error_code >= 400 && err.error_code < 500) return null;
    return Math.min(30_000, 2 ** attempt * 1_000);
  }
  if (err instanceof HttpError) return Math.min(30_000, 2 ** attempt * 1_000);
  // Timeouts and socket resets are the documented failure mode of long polling over
  // laptop wifi, so they get a couple of cheap retries before giving up.
  return attempt < 3 ? Math.min(5_000, 2 ** attempt * 500) : null;
}

export class TelegramChannel implements ChannelAdapter {
  readonly name = 'telegram';
  readonly account: string;

  readonly #bot: Bot;
  readonly #options: Required<Omit<TelegramOptions, 'account'>>;
  /** Approval id -> resolver, so an inline button can answer it. */
  readonly #approvals = new Map<
    string,
    { resolve: (choice: ApprovalChoice) => void; expires: number; chatId: string }
  >();
  #handlers: ChannelHandlers | null = null;
  #ready = false;
  /** Reconnect state: a terminal polling failure retries with backoff. */
  #stopped = false;
  #pollingDown = false;
  #retryMs = 5_000;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Health evidence: a getUpdates completed since the last (re)start. */
  #pollingConfirmed = false;
  #healthProbeInstalled = false;
  /**
   * One gate for every outbound call in the process.
   *
   * Telegram documents "avoid sending more than one message per second in a single
   * chat", and separately warns that firing concurrent requests at a throttled peer
   * makes the cooldown longer rather than shorter. That is exactly the shape of a
   * parallel multi-conversation agent: without a single global gate, three threads
   * answering at once multiply the penalty into a lockout. So sends are serialised
   * process-wide and spaced, and `retry_after` is obeyed here rather than by each
   * caller sleeping on its own.
   */
  readonly #sendGate = new Mutex();
  /** chatId -> epoch ms of the last accepted send, to space out bursts. */
  readonly #lastSentAt = new Map<string, number>();

  constructor(options: TelegramOptions) {
    this.account = options.account ?? 'main';
    this.#options = {
      token: options.token,
      allowedUserIds: options.allowedUserIds,
      approvalTtlMs: options.approvalTtlMs ?? 300_000,
    };
    this.#bot = new Bot(this.#options.token);
  }

  isReady(): boolean {
    return this.#ready;
  }

  async start(handlers: ChannelHandlers): Promise<void> {
    this.#handlers = handlers;
    const bot = this.#bot;

    bot.catch((err) => {
      handlers.log('error', 'grammy error', { message: err.message });
    });

    bot.on('message', (ctx) => this.#onMessage(ctx));
    bot.on('callback_query:data', (ctx) => this.#onCallback(ctx));

    // Command menu in the Telegram UI, so the useful commands are discoverable
    // without remembering them. Telegram caps this at 100 and orders as given.
    void this.#bot.api
      .setMyCommands(TELEGRAM_COMMANDS.map((command) => ({ ...command })))
      .catch(() => {});

    // A terminal polling failure used to be the end: one log line and the
    // channel stayed dead until a daemon restart, with no word to the user
    // (audit, line 120). Now it reconnects on its own with backoff and says
    // so once per outage, like the wake listener does.
    this.#stopped = false;
    // grammY's onStart fires after init/deleteWebhook and BEFORE the first
    // getUpdates (bot.js: onStart, then the loop), so it proves setup, NOT
    // polling: a terminal 409 happens after it. The health signal is a
    // completed getUpdates — an empty batch counts — observed through an API
    // transformer. Only that marks the channel ready, resets the backoff and
    // reports a recovery; a 409 loop escalates 5s -> 5min with a single
    // outage notice and zero false recoveries (auditor, #153 ronda 1).
    if (!this.#healthProbeInstalled) {
      this.#healthProbeInstalled = true;
      bot.api.config.use(async (prev, method, payload, signal) => {
        // The transformer sees the RAW response: grammY throws the GrammyError
        // AFTER the transformers, in ApiClient.callApi (client.js:92-97). A
        // completed 409 arrives here as { ok: false, ... }, so health demands
        // ok === true AND a real batch — never just "no throw" (auditor #153
        // ronda 2).
        const result = await prev(method, payload, signal);
        if (
          method === 'getUpdates' &&
          result.ok === true &&
          Array.isArray(result.result) &&
          !this.#stopped &&
          !this.#pollingConfirmed
        ) {
          this.#pollingConfirmed = true;
          this.#ready = true;
          this.#retryMs = 5_000;
          const wasDown = this.#pollingDown;
          this.#pollingDown = false;
          this.#handlers?.log('info', 'telegram polling healthy', {});
          if (wasDown) void this.#handlers?.onPollingRecovered?.('telegram');
        }
        return result;
      });
    }
    const poll = async (): Promise<void> => {
      this.#pollingConfirmed = false;
      try {
        await bot.start({
          onStart: (me) => {
            // A late onStart after stop() must not resurrect the channel.
            if (this.#stopped) return;
            handlers.log('info', 'telegram connected', { username: me.username, id: me.id });
          },
        });
        // A resolve means polling ended. If it was our own stop() there is
        // nothing to do; otherwise the channel just died quietly, which is
        // exactly what the retry loop exists for.
        if (this.#stopped) return;
        this.#ready = false;
        const message = 'polling ended without a stop call';
        handlers.log('error', 'telegram polling stopped', { message });
        this.#scheduleRetry(handlers, poll, message);
      } catch (err: unknown) {
        if (this.#stopped) return;
        this.#ready = false;
        const message = err instanceof Error ? err.message : String(err);
        handlers.log('error', 'telegram polling stopped', { message });
        this.#scheduleRetry(handlers, poll, message);
      }
    };
    void poll();
  }

  /**
   * One reconnect notice per outage (the failure repeats until fixed, so the
   * message would too), then backoff 5s -> 5min cap. stop() cancels a pending
   * retry through #stopped + #retryTimer.
   */
  #scheduleRetry(handlers: ChannelHandlers, poll: () => Promise<void>, message: string): void {
    if (this.#stopped) return;
    if (!this.#pollingDown) {
      this.#pollingDown = true;
      void handlers.onPollingLost?.('telegram', message);
    }
    const wait = this.#retryMs;
    this.#retryMs = Math.min(this.#retryMs * 2, 300_000);
    handlers.log('info', 'telegram reconnect scheduled', { inMs: wait });
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void poll();
    }, wait);
  }

  async #onMessage(ctx: Context): Promise<void> {
    const handlers = this.#handlers;
    if (!handlers) return;
    const msg = ctx.message;
    const user = ctx.from;
    if (!msg || !user) return;

    const text = (msg.text ?? msg.caption ?? '').trim();

    if (!this.#options.allowedUserIds.includes(user.id)) {
      handlers.log('warn', 'unauthorised sender', { userId: user.id, username: user.username });
      await ctx.reply('Este asistente es privado.').catch(() => {});
      return;
    }

    const isGroup = ctx.chat?.type !== 'private';
    if (isGroup && !isAddressedToBot(text, msg, ctx.me.username)) {
      // Groups are read-only by default: the bot only acts when mentioned or
      // replied to. Otherwise every group message would burn a computer-use run,
      // and the reply would leak to members who are not allowlisted.
      handlers.log('debug', 'group message without mention ignored', { chatId: ctx.chat?.id });
      return;
    }

    // Voice notes are carried through as audio, not transcribed here. Transcription
    // is CPU-bound and slow on first use (the model has to load from disk), and
    // doing it in the message handler would block every other chat behind a
    // multi-second model load. The turn downloads and transcribes it instead.
    const voice = 'voice' in msg ? msg.voice : undefined;
    const audio = 'audio' in msg ? msg.audio : undefined;
    const note = 'video_note' in msg ? msg.video_note : undefined;
    // Audio sent "as a file" arrives as a document: same bytes, so it takes the same
    // road (saved, transcribed, playable on the PC) instead of the document one.
    const asFile = msg.document && isAudioDocument(msg.document) ? msg.document : undefined;
    const incomingAudio = voice ?? audio ?? note ?? asFile;

    const inbound: Inbound = {
      channel: this.name,
      account: this.account,
      chatId: String(ctx.chat?.id ?? ''),
      threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
      userId: String(user.id),
      displayName: user.username ? `@${user.username}` : user.first_name,
      text,
      authorised: true,
      isGroup,
      messageId: String(msg.message_id),
      receivedAt: new Date().toISOString(),
      replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
    };

    if (incomingAudio) {
      inbound.audioFileId = incomingAudio.file_id;
      // Telegram reports the real codec on voice and audio, and the transcriber
      // needs it: the bytes of an mp3 attachment decoded as opus give a fluent,
      // wrong transcript, which is worse than saying "I cannot read that format".
      // A video note has no mime type at all and is always ogg/opus.
      const reported = (incomingAudio as { mime_type?: string }).mime_type;
      inbound.audioMimeType = reported ?? 'audio/ogg';
      inbound.audioDurationSeconds =
        'duration' in incomingAudio ? (incomingAudio.duration ?? undefined) : undefined;
      if (!inbound.text) inbound.text = '';
    }

    if (msg.photo?.length) {
      const best = msg.photo[msg.photo.length - 1];
      // Downloaded lazily inside the turn (see downloadPhoto): doing it here would
      // reorder messages behind a slow download and stall before queueing.
      if (best) inbound.photoFileId = best.file_id;
    }

    if (msg.document && !asFile) {
      // Kept to ids and metadata: the bytes are fetched inside the turn, which
      // is also where the document memory learns whether it can read them.
      inbound.documentFileId = msg.document.file_id;
      inbound.documentMimeType = msg.document.mime_type ?? undefined;
      inbound.documentName = msg.document.file_name ?? undefined;
      if (!inbound.text) inbound.text = '';
    }

    // A command with no text must still reach the handler: `/screen` and `/watch`
    // are handled before the agent exists, and a caption-less photo needs its file
    // id even though there is nothing to say about it.
    if (!inbound.text && !inbound.photoFileId && !inbound.audioFileId && !inbound.documentFileId)
      return;

    await handlers.onMessage(inbound);
  }

  /** Returns a refusal message when the sender may not act, else null. */
  #authorise(userId: number, label: string, handlers: ChannelHandlers): string | null {
    if (!this.#options.allowedUserIds.includes(userId)) {
      handlers.log('warn', 'unauthorised sender', { userId, label });
      return 'Este asistente es privado.';
    }
    return null;
  }

  async #onCallback(ctx: Context): Promise<void> {
    const handlers = this.#handlers;
    if (!handlers) return;
    const data = ctx.callbackQuery?.data;
    if (!data) return;
    const userId = ctx.from?.id;
    if (!userId) return;

    const refusal = this.#authorise(userId, ctx.from?.username ?? String(userId), handlers);
    if (refusal) {
      await ctx.answerCallbackQuery({ text: refusal, show_alert: false }).catch(() => {});
      return;
    }

    const parsed = parseApprovalCallback(data);
    const entry = parsed ? this.#approvals.get(parsed.id) : undefined;
    if (!parsed || !entry || entry.expires < Date.now()) {
      await ctx.answerCallbackQuery({ text: 'That request is no longer pending.' }).catch(() => {});
      return;
    }

    this.#approvals.delete(parsed.id);
    // `deny:<id>` carries no scope of its own; parseApprovalCallback reports it as
    // 'once', which is exactly the shape a refusal must have for the gate.
    const choice: ApprovalChoice = {
      approved: data.startsWith('approve:'),
      scope: parsed.scope,
    };
    entry.resolve(choice);
    // Only identifiers here: the question embeds the gate's `reason`, and a log
    // line is not the place for whatever that quoted. `redact` covers the fields
    // that must carry text (see offerApproval).
    handlers.log('info', 'approval decided', {
      id: parsed.id,
      approved: choice.approved,
      scope: choice.scope,
    });
    await this.#announceDecision(ctx, choice);
  }

  /**
   * Answer the press so Telegram stops spinning the button, then stamp the
   * verdict over the question and clear its keyboard.
   *
   * The buttons must not outlive the decision they produced: a second press would
   * only find an expired request and confuse the user. An explicit empty keyboard
   * is what clears them, and the verdict text (not the toast) is what stays in the
   * chat afterwards so "what did I just approve?" has a permanent answer.
   */
  async #announceDecision(ctx: Context, choice: ApprovalChoice): Promise<void> {
    const label = decisionLabel(choice);
    await ctx.answerCallbackQuery({ text: label }).catch(() => {});
    const message = ctx.callbackQuery?.message;
    if (!message) return;
    await this.#throttled(() =>
      withTimeout(
        this.#bot.api.editMessageText(message.chat.id, message.message_id, label, {
          reply_markup: { inline_keyboard: [] },
        }),
        20_000,
        'editMessageText timed out',
      ),
    ).catch((err: unknown) => {
      // The decision is already resolved and answered, so a failed stamp is a
      // cosmetic miss and must never fail the turn that was waiting on it.
      log.warn('approval stamp failed', { error: describeError(err), ...redact({ err }) });
    });
  }

  /**
   * Publish an approval with inline buttons; resolves with the scope the human
   * picked, or as refused when it expires, is cancelled, or the send fails.
   *
   * `askScope` swaps the plain yes/no pair for the four-button prompt: the human
   * answers not just "may I?" but "for how long?", which is what feeds
   * `Gate.setScope` on the caller side. Without it the legacy two buttons stay,
   * and any of their answers is reported as `scope: 'once'`.
   */
  offerApproval(
    id: string,
    chatId: string,
    question: string,
    opts?: { askScope?: boolean },
  ): Promise<ApprovalChoice> {
    return new Promise<ApprovalChoice>((resolve) => {
      let settled = false;
      const settle = (choice: ApprovalChoice): void => {
        if (settled) return;
        settled = true;
        this.#approvals.delete(id);
        resolve(choice);
      };
      this.#approvals.set(id, {
        resolve: settle,
        expires: Date.now() + this.#options.approvalTtlMs,
        chatId,
      });
      setTimeout(() => {
        this.#approvals.delete(id);
        settle({ approved: false, scope: 'once' });
      }, this.#options.approvalTtlMs).unref();

      // The question embeds the gate's `reason`, which may quote a credential the
      // tool was about to touch. Redaction is the codebase's scrub for exactly
      // that, and it is why the question itself is never logged any other way.
      log.debug('approval offered', { id, chatId, ...redact({ question }) });

      void this.send({
        channel: this.name,
        account: this.account,
        chatId,
        text: question,
        buttons: opts?.askScope
          ? [
              { label: 'Una vez', action: `approve:once:${id}` },
              { label: 'Esta sesión', action: `approve:session:${id}` },
              { label: 'Siempre', action: `approve:always:${id}` },
              { label: 'Denegar', action: `deny:${id}` },
            ]
          : [
              { label: 'Permitir', action: `approve:${id}` },
              { label: 'Denegar', action: `deny:${id}` },
            ],
      }).catch(() => settle({ approved: false, scope: 'once' }));
    });
  }

  /** Resolve every pending approval in one chat as denied. Used by /stop. */
  cancelForChat(chatId: string): void {
    for (const [id, entry] of this.#approvals) {
      if (entry.chatId === chatId) {
        this.#approvals.delete(id);
        entry.resolve({ approved: false, scope: 'once' });
      }
    }
  }

  /** Resolve every pending approval as denied. Used on shutdown. */
  cancelApprovals(): void {
    for (const [id, entry] of this.#approvals) {
      this.#approvals.delete(id);
      entry.resolve({ approved: false, scope: 'once' });
    }
  }

  /**
   * Send, returning the id of the first message sent.
   *
   * The id matters twice over: it is what makes an answer quote the exact message it
   * answers instead of floating free in the chat, and it is the key that routes a
   * later reply back to the same conversation.
   */
  async send(outbound: Outbound): Promise<string | null> {
    const chatId = Number(outbound.chatId);
    if (!Number.isFinite(chatId)) {
      throw new Error(`invalid telegram chat id: ${outbound.chatId}`);
    }

    let firstId: string | null = null;

    // Buttons ride on the first chunk only: repeating them on every chunk of a long
    // message would produce duplicate approvals for the same request.
    let first = true;
    for (const chunk of chunkText(outbound.text, 4000)) {
      const options = (withThread: boolean, withReply: boolean) => ({
        message_thread_id: withThread && outbound.threadId ? Number(outbound.threadId) : undefined,
        reply_to_message_id:
          withReply && outbound.replyToMessageId ? Number(outbound.replyToMessageId) : undefined,
        reply_markup:
          first && outbound.buttons?.length ? buildKeyboard(outbound.buttons) : undefined,
      });
      const call = (withThread: boolean, withReply: boolean) =>
        this.#throttled(() =>
          withTimeout(
            this.#bot.api.sendMessage(chatId, chunk, options(withThread, withReply)),
            20_000,
            'sendMessage timed out',
          ),
        );
      let sent: Awaited<ReturnType<typeof call>>;
      try {
        sent = await call(true, true);
      } catch (err) {
        // Un reply a un mensaje borrado o un tema cerrado da un 400 permanente. Antes
        // eso perdía la respuesta entera: se reintenta UNA vez sin hilo ni reply, que
        // siempre entrega (en General) en vez de dejar al usuario sin nada.
        const refProblem =
          err instanceof GrammyError &&
          err.error_code === 400 &&
          /thread|topic|reply/i.test(err.description);
        if (!refProblem || (!outbound.threadId && !outbound.replyToMessageId)) throw err;
        log.warn('telegram send rejected the thread/reply target, sending without them', {
          error: describeError(err),
        });
        sent = await call(false, false);
      }
      if (firstId === null && sent?.message_id) firstId = String(sent.message_id);
      first = false;
    }

    for (const image of outbound.images ?? []) {
      await this.sendPhotoBytes(chatId, Buffer.from(image.data, 'base64'), outbound.threadId);
    }

    if (outbound.audio) {
      await this.#sendAudio(chatId, outbound.audio);
    }

    return firstId;
  }

  /**
   * Send a photo.
   *
   * Telegram enforces `width + height <= 10000` and `aspect ratio <= 20` on photos
   * and answers anything else with `PHOTO_INVALID_DIMENSIONS`. A full-page browser
   * screenshot can be 1280x11000, so this validates before sending and falls back to
   * a document, which has no dimension rules and is not re-encoded. Without the
   * fallback the user gets nothing for a valid-looking image.
   */
  /**
   * Returns the id of the message it created. A live view needs that id to refresh the
   * same bubble, and without it the only alternative is to leave a trail of photos.
   */
  async sendPhotoBytes(
    chatId: number,
    bytes: Buffer,
    threadId?: string,
    size?: { width: number; height: number },
  ): Promise<string | null> {
    const input = new InputFile(bytes);
    const t = { message_thread_id: threadId ? Number(threadId) : undefined };
    if (size && (size.width + size.height > 10_000 || size.width / size.height > 20)) {
      log.warn('image geometry violates the photo limit, sending as a document instead', {
        ...size,
      });
      const doc = await this.#throttled(() =>
        withTimeout(this.#bot.api.sendDocument(chatId, input, t), 60_000, 'sendDocument timed out'),
      );
      return doc?.message_id ? String(doc.message_id) : null;
    }
    const sent = await this.#throttled(() =>
      withTimeout(this.#bot.api.sendPhoto(chatId, input, t), 45_000, 'sendPhoto timed out'),
    );
    return sent?.message_id ? String(sent.message_id) : null;
  }

  /**
   * Send a recording of the user's microphone as a voice note.
   *
   * Ogg/Opus is the native voice-note format and gets the waveform bubble; that is why
   * the capture side encodes to ogg rather than mp3.
   */
  async sendVoiceBytes(
    chatId: number,
    bytes: Buffer,
    threadId: string | undefined,
    seconds: number,
  ): Promise<void> {
    await this.#throttled(() =>
      withTimeout(
        this.#bot.api.sendVoice(chatId, new InputFile(bytes), {
          message_thread_id: threadId ? Number(threadId) : undefined,
          caption: `. ${Math.round(seconds)}s de microfono`.slice(0, 1024),
        }),
        60_000,
        'sendVoice timed out',
      ),
    );
  }

  /**
   * Replace the photo of a message we already sent.
   *
   * This is what makes a live view possible. Telegram has no streaming primitive a bot
   * can use, and the documented send rate is about one message per second, so sending a
   * frame every few seconds would leave a hundred permanent photos in the chat. Editing
   * one message instead gives the user a single bubble that keeps updating in place -
   * the thing that actually feels like watching - with none of the clutter and well
   * inside the documented limits.
   */
  async editPhoto(chatId: string, messageId: string, bytes: Buffer): Promise<void> {
    await this.#throttled(() =>
      withTimeout(
        this.#bot.api.editMessageMedia(Number(chatId), Number(messageId), {
          type: 'photo',
          media: new InputFile(bytes),
        }),
        30_000,
        'editMessageMedia timed out',
      ),
    );
  }

  /**
   * Replace the text of a message already sent.
   *
   * This is what turns the trail of "Sigo con ello" progress notes into one bubble
   * that updates in place. Failures are swallowed on purpose: Telegram refuses an
   * edit that changes nothing and edits past 48h, and a stale progress note is
   * never worth failing the turn that was reporting on.
   */
  async editMessageText(chatId: string, messageId: string, text: string): Promise<void> {
    const ref = parseMessageRef(chatId, messageId);
    if (!ref) return;
    await this.#throttled(() =>
      withTimeout(
        this.#bot.api.editMessageText(ref.chatId, ref.messageId, text),
        20_000,
        'editMessageText timed out',
      ),
    ).catch((err: unknown) => {
      log.warn('editMessageText failed', { error: describeError(err) });
    });
  }

  /**
   * Delete one of our own messages, so a finished task leaves no progress chatter
   * behind. Same swallow-on-failure contract as editMessageText: cleanup runs at
   * the end of a turn and must never be able to fail it.
   */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    const ref = parseMessageRef(chatId, messageId);
    if (!ref) return;
    await this.#throttled(() =>
      withTimeout(
        this.#bot.api.deleteMessage(ref.chatId, ref.messageId),
        20_000,
        'deleteMessage timed out',
      ),
    ).catch((err: unknown) => {
      log.warn('deleteMessage failed', { error: describeError(err) });
    });
  }

  /**
   * Send a recorded screen clip.
   *
   * `sendVideo` is documented as MPEG4, and x264 in an mp4 container is exactly
   * that. This is the only Bot API mechanism that gives real playback with seeking:
   * streaming frames as photos is capped at one message per second and Telegram
   * re-encodes every one of them, so a "live" screen over photos is neither live nor
   * cheap. The 50MB upload cap is the only documented limit.
   */
  async sendVideo(
    chatId: number,
    bytes: Buffer,
    durationSeconds: number,
    caption: string,
  ): Promise<void> {
    await this.#throttled(() =>
      withTimeout(
        this.#bot.api.sendVideo(chatId, new InputFile(bytes), {
          caption: `${caption} (${Math.round(durationSeconds)}s)`.slice(0, 1024),
          supports_streaming: true,
        }),
        120_000,
        'sendVideo timed out',
      ),
    );
  }

  /**
   * Send a file as a document (PDFs and anything else Telegram should not re-encode).
   * The 50MB upload cap is the only documented limit; callers check it first.
   */
  async sendDocumentBytes(
    chatId: number,
    bytes: Buffer,
    filename: string,
    caption: string,
    threadId?: string,
  ): Promise<void> {
    await this.#throttled(() =>
      withTimeout(
        this.#bot.api.sendDocument(chatId, new InputFile(bytes, filename), {
          caption: caption.slice(0, 1024),
          message_thread_id: threadId ? Number(threadId) : undefined,
        }),
        120_000,
        'sendDocument timed out',
      ),
    );
  }

  /**
   * Serialise, space, and retry one API call.
   *
   * `retry_after` is obeyed exactly as Telegram documents it; 5xx and network errors
   * get exponential backoff instead, because they carry no `retry_after` and
   * retrying immediately just hits the same failing endpoint again.
   *
   * The retries are FINITE and share a deadline. Before this, a dead endpoint (or a
   * 429 with a long retry_after) retried forever inside the single global send gate:
   * one stuck call froze every chat, and the turn waiting on the send could not be
   * stopped. Failing after a bounded wait is always better than never answering.
   */
  async #throttled<T>(call: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + SEND_MAX_TOTAL_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#sendGate.run(async () => {
          const wait = (this.#lastSentAt.get(GLOBAL_KEY) ?? 0) + MIN_GAP_MS - Date.now();
          if (wait > 0) await sleep(wait);
          const value = await call();
          // Stamped only on success: a call that never happened must not consume the
          // spacing budget of the next one.
          this.#lastSentAt.set(GLOBAL_KEY, Date.now());
          return value;
        });
      } catch (err) {
        const wait = backoffFor(err, attempt);
        if (wait === null || attempt + 1 >= SEND_MAX_ATTEMPTS || Date.now() + wait > deadline) {
          throw err;
        }
        log.warn('telegram send failed, retrying', { attempt, wait, error: describeError(err) });
        await sleep(wait);
      }
    }
  }

  /**
   * Send synthesised speech.
   *
   * Documented since Bot API 7.3: `sendVoice` accepts ogg/opus, mp3 and m4a. A voice
   * bubble is what the user expects back for a voice note; `sendAudio` would render
   * the same bytes in the music player behind a title bar. The buffer is uploaded
   * rather than passed by URL, because the URL path documents an ogg/1MB cap that
   * would demote an mp3 to a plain attachment.
   */
  async #sendAudio(chatId: number, audio: ChannelAudio): Promise<void> {
    const bytes = Buffer.from(audio.data, 'base64');
    if (bytes.length === 0) {
      log.warn('voice output rejected: empty bytes');
      return;
    }
    const duration = audio.durationSeconds;
    await this.#throttled(() =>
      withTimeout(
        this.#bot.api.sendVoice(
          chatId,
          new InputFile(bytes, audio.mimeType === 'audio/wav' ? 'voice.wav' : 'voice.mp3'),
          {
            duration: duration && duration > 0 ? Math.ceil(duration) : undefined,
            caption: audio.durationSeconds ? `. ${Math.round(audio.durationSeconds)}s` : undefined,
          },
        ),
        60_000,
        'sendVoice timed out',
      ),
    ).catch((err: unknown) => {
      // The text already went out, so a failed attachment is a degraded reply rather
      // than a failed one. Log and move on.
      log.warn('voice send failed', { error: describeError(err) });
    });
  }

  /**
   * Download any file by id: photos, voice notes, documents.
   *
   * Two-step by Bot API contract: `getFile` first for the real path, then the file
   * endpoint. (The old code pasted the file_id where the path goes, so every photo
   * silently 404'd.)
   */
  async downloadFile(fileId: string, limitBytes = 20_000_000): Promise<Buffer | null> {
    const file = await withTimeout(
      this.#bot.api.getFile(fileId),
      15_000,
      'getFile timed out',
    ).catch(() => null);
    if (!file?.file_path) return null;
    const url = `https://api.telegram.org/file/bot${this.#options.token}/${file.file_path}`;
    return withTimeout(
      fetch(url).then(async (r) => {
        if (!r.ok) throw new Error(`file download: HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > limitBytes) throw new Error(`file exceeds ${limitBytes} bytes`);
        return buf;
      }),
      60_000,
      'file download timed out',
    ).catch(() => null);
  }

  /**
   * Show that the bot is working on something. Telegram expires the indicator after
   * about five seconds, so long tasks refresh it. It carries no content, which is
   * what makes it safe to call blindly.
   */
  async action(
    chatId: string,
    action:
      | 'typing'
      | 'upload_photo'
      | 'upload_voice'
      | 'upload_video'
      | 'upload_document' = 'typing',
  ): Promise<void> {
    const id = Number(chatId);
    if (!Number.isFinite(id)) return;
    await withTimeout(
      this.#bot.api.sendChatAction(id, action),
      15_000,
      'sendChatAction timed out',
    ).catch(() => {});
  }

  async stop(strict = false): Promise<void> {
    this.#stopped = true;
    this.#ready = false;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    await this.#bot.stop().catch((error: unknown) => {
      if (strict)
        throw new Error('No se pudo confirmar el cierre de polling Telegram.', { cause: error });
    });
  }

  /**
   * Photos go through the generic downloader. It stays a named method because the
   * photo path is called on every image the user sends and a failure there has a
   * different consequence (an image-less turn) than an audio failure.
   */
  async downloadPhoto(fileId: string): Promise<Buffer | null> {
    return this.downloadFile(fileId, 20_000_000);
  }
}

/**
 * Matches `/stop`, with or without the `@botname` suffix Telegram appends in
 * groups, and with or without trailing text. The old exact-match missed
 * `/stop@asistenta_personal_bot` entirely.
 */
const STOP_COMMAND = /^\/stop(@\w+)?(\s|$)/i;
export function isStopCommand(text: string): boolean {
  return STOP_COMMAND.test(text.trim());
}

/**
 * Whether a group message is addressed to the bot: an @mention of its username or
 * a reply to one of its messages. Anything else in a group is someone else's
 * conversation and must not start a run.
 */
export function isAddressedToBot(
  text: string,
  message: { reply_to_message?: unknown },
  botUsername: string,
): boolean {
  if (text.includes(`@${botUsername}`)) return true;
  const reply = message.reply_to_message as { from?: { is_bot?: boolean } } | undefined;
  return reply?.from?.is_bot === true;
}

/**
 * Parse the string message references the channel layer carries into the numeric
 * pair the Bot API needs. Returns null when either side cannot name a real message,
 * so a caller can skip a doomed edit instead of throwing mid-cleanup. Group chats
 * use negative chat ids, so only zero is excluded there; message ids are positive.
 */
export function parseMessageRef(
  chatId: string,
  messageId: string,
): { chatId: number; messageId: number } | null {
  const chat = chatId.trim();
  const message = messageId.trim();
  if (chat === '' || message === '') return null;
  const chatNum = Number(chat);
  const messageNum = Number(message);
  if (!Number.isSafeInteger(chatNum) || chatNum === 0) return null;
  if (!Number.isSafeInteger(messageNum) || messageNum <= 0) return null;
  return { chatId: chatNum, messageId: messageNum };
}

/**
 * Scoped approve payloads must be read before the legacy one, or `approve:once:x`
 * would fall through and be mistaken for an id of `once:x`.
 */
const SCOPED_APPROVAL_PREFIXES: ReadonlyArray<readonly [string, ApprovalScope]> = [
  ['approve:once:', 'once'],
  ['approve:session:', 'session'],
  ['approve:always:', 'always'],
];

/**
 * Parse one inline-button callback payload into the approval it answers and the
 * scope the human chose.
 *
 * Takes the four button payloads (`approve:once:<id>`, `approve:session:<id>`,
 * `approve:always:<id>`, `deny:<id>`) plus the pre-scope `approve:<id>`, kept as
 * `scope: 'once'` so buttons already sitting in a chat still work. `deny` has no
 * scope of its own and is reported as `'once'`, which is exactly the shape a
 * refusal takes downstream (`{ approved: false, scope: 'once' }`). The id is the
 * rest of the payload verbatim, colons included, exactly as the old handler read
 * it. Anything else is foreign callback data and returns null, so a stray button
 * can never resolve somebody's pending approval by accident.
 */
export function parseApprovalCallback(data: string): { id: string; scope: ApprovalScope } | null {
  for (const [prefix, scope] of SCOPED_APPROVAL_PREFIXES) {
    if (data.startsWith(prefix)) {
      const id = data.slice(prefix.length);
      return id === '' ? null : { id, scope };
    }
  }
  const verb = data.startsWith('approve:') ? 'approve' : data.startsWith('deny:') ? 'deny' : null;
  if (!verb) return null;
  const id = data.slice(verb.length + 1);
  return id === '' ? null : { id, scope: 'once' };
}

/** Spanish verdicts, one per scope. */
const DECISION_LABELS: Record<ApprovalScope, string> = {
  once: '✅ Aprobado para esta vez',
  session: '✅ Aprobado para esta sesión',
  always: '✅ Aprobado siempre',
};

/**
 * The verdict line, shared by the callback toast and the message stamp so the two
 * can never disagree about what was decided. Spanish because it is user-facing.
 */
function decisionLabel(choice: ApprovalChoice): string {
  if (!choice.approved) return '❌ Denegado';
  return DECISION_LABELS[choice.scope];
}

/**
 * One button per entry, in order, with the action's own callback data verbatim.
 *
 * The previous version searched for a button whose `action` literally equalled
 * 'approve', which never matched (actions are UUIDs), so it appended every button
 * twice *and* prefixed all of them with `approve:` — which meant the Deny button
 * approved. Callback data is passed through untouched and the decision is carried
 * inside it, so there is exactly one place that decides approve vs deny.
 */
function buildKeyboard(buttons: Array<{ label: string; action: string }>): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const b of buttons) {
    kb.text(b.label, b.action);
  }
  return kb;
}

/**
 * Telegram caps a message at 4096 chars, so longer text is split. Split on code
 * points, not UTF-16 units: slicing mid-emoji produces a lone surrogate and a
 * replacement character in the user's chat.
 */
export function chunkText(text: string, size: number): string[] {
  const points = Array.from(text);
  if (points.length <= size) return [text];
  const out: string[] = [];
  for (let i = 0; i < points.length; i += size) out.push(points.slice(i, i + size).join(''));
  return out;
}

const AUDIO_FILE_NAME = /\.(?:mp3|m4a|aac|ogg|oga|opus|wav|flac|amr|wma)$/i;

/**
 * Is a Telegram document really an audio recording?
 *
 * "Send as file" turns a voice note, an mp3 or a WhatsApp export into a document, and
 * the document road neither saves it for /play nor transcribes it. The MIME type is
 * the evidence; when Telegram sends a generic type, the extension decides.
 */
export function isAudioDocument(doc: { mime_type?: string; file_name?: string }): boolean {
  const mime = (doc.mime_type ?? '').toLowerCase();
  if (mime.startsWith('audio/') || mime === 'application/ogg') return true;
  if (mime && mime !== 'application/octet-stream') return false;
  return AUDIO_FILE_NAME.test(doc.file_name ?? '');
}
