import { randomBytes } from 'node:crypto';
import { Bot, type Context, GrammyError, HttpError, InlineKeyboard, InputFile } from 'grammy';
import { FUNCIONES_CALLBACK_PREFIX } from '../funciones.js';
import { log, redact } from '../log.js';
import { TV_CALLBACK_PREFIX } from '../tv/tv-chat-command.js';
import { Mutex, withTimeout } from '../utils.js';
import { cleanForTelegram, stripMarks, stripVoicePrefix, telegramHtml } from './formatters.js';
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

/** Estado de un borrador ya publicado: el mensaje que se edita y lo último aplicado. */
interface DraftState {
  chatId: number;
  messageId: string;
  text: string;
  /** null hasta la primera edición, para no frenar la primera versión del borrador. */
  lastEditAt: number | null;
}

/** Entrada de la caché de respuestas completas, con su instante de caducidad. */
interface CachedReply {
  text: string;
  expires: number;
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

/**
 * Cadencia por defecto del borrador. Editar más a menudo que esto multiplica las
 * llamadas a la Bot API sin que el ojo humano llegue a leer las versiones intermedias.
 */
const DRAFT_MIN_INTERVAL_MS = 1_200;

/** Lo que queda escrito cuando una aprobación caduca sin respuesta. */
const APPROVAL_EXPIRED_TEXT = 'Caducada';

/**
 * Una respuesta completa se guarda para "Dime más". Diez minutos cubren la lectura
 * normal de un mensaje y 24 entradas acotan la memoria por proceso sin expulsar los
 * hilos recientes.
 */
const FULL_REPLY_TTL_MS = 10 * 60_000;
const FULL_REPLY_MAX_ENTRIES = 24;

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

/**
 * Los dos 400 que una edición de borrador debe tolerar.
 *
 * "message is not modified" solo significa que el texto ya era ese; "message can't
 * be edited" aparece cuando el mensaje es demasiado antiguo o ya no admite edición.
 * Ninguno justifica perder el turno ni reintentar: el borrador es una mejora visual.
 */
function isDraftEditRefusal(err: unknown): boolean {
  if (!(err instanceof GrammyError) || err.error_code !== 400) return false;
  return /message is not modified|message can(?:not|'t| not) be edited/i.test(err.description);
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
  /** A 429 blocks every caller, including requests already queued at the gate. */
  #cooldownUntil = 0;
  #cooldownError: GrammyError | null = null;
  /** Borradores vivos por chat y tema: `chatId:threadId`. */
  readonly #drafts = new Map<string, DraftState>();
  /** Serializa las comprobaciones y transiciones del borrador (no las llamadas API). */
  readonly #draftGate = new Mutex();

  constructor(options: TelegramOptions) {
    this.account = options.account ?? 'main';
    this.#options = {
      token: options.token,
      allowedUserIds: options.allowedUserIds,
      approvalTtlMs: options.approvalTtlMs ?? 300_000,
    };
    this.#bot = new Bot(this.#options.token);
  }

  /** Mensaje con el texto completo de «📖 Ver todo» → mensaje recortado del que salió. */
  readonly #replyAliases = new Map<string, string>();

  #aliasReply(chatId: string, messageId: string, target: string): void {
    this.#replyAliases.set(`${chatId}:${messageId}`, target);
    while (this.#replyAliases.size > 200) {
      const oldest = this.#replyAliases.keys().next();
      if (oldest.done) break;
      this.#replyAliases.delete(oldest.value);
    }
  }

  #resolveReply(chatId: string, messageId: string): string {
    return this.#replyAliases.get(`${chatId}:${messageId}`) ?? messageId;
  }

  /** Quita el teclado inline de un mensaje propio; un fallo (ya editado, borrado) no importa. */
  #clearKeyboard(chatId: number, messageId: number): void {
    void this.#throttled(() =>
      withTimeout(
        this.#bot.api.editMessageReplyMarkup(chatId, messageId, {
          reply_markup: { inline_keyboard: [] },
        }),
        20_000,
        'editMessageReplyMarkup timed out',
      ),
    ).catch(() => {});
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
    void configureCommandMenu(this.#bot.api);

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

    const isGroup = ctx.chat?.type !== 'private';

    if (!this.#options.allowedUserIds.includes(user.id)) {
      handlers.log('warn', 'unauthorised sender', { userId: user.id, username: user.username });
      // En un grupo, contestar a cada mensaje de cada miembro no permitido llenaba
      // el chat de «Este asistente es privado.» y gastaba el cupo de envíos. Allí
      // se calla; el aviso solo va por privado.
      if (!isGroup) await ctx.reply('Este asistente es privado.').catch(() => {});
      return;
    }

    if (isGroup && !isAddressedToBot(text, msg, ctx.me.username, ctx.me.id)) {
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
      replyToMessageId: msg.reply_to_message
        ? this.#resolveReply(String(msg.chat?.id), String(msg.reply_to_message.message_id))
        : undefined,
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

    // «📖 Ver todo» va ANTES que las aprobaciones y por su propio camino: nunca
    // resuelve, consume ni toca una aprobación pendiente.
    if (data.startsWith(MORE_CALLBACK_PREFIX)) {
      await this.#onMorePress(ctx, data.slice(MORE_CALLBACK_PREFIX.length));
      return;
    }

    // Mando de la tele (/tv sin orden): también por su propio camino, nunca
    // toca aprobaciones. Dueño + chat privado lo comprueba quien ejecuta.
    if (data.startsWith(TV_CALLBACK_PREFIX)) {
      await this.#onTvPress(ctx, handlers, data, userId);
      return;
    }

    // Áreas de /funciones: solo cambian el texto del mensaje, nunca tocan
    // aprobaciones. Quién ve qué lo decide el daemon (dueño en privado o no).
    if (data.startsWith(FUNCIONES_CALLBACK_PREFIX)) {
      await this.#onFuncionesPress(ctx, handlers, data, userId);
      return;
    }

    const parsed = parseApprovalCallback(data);
    const entry = parsed ? this.#approvals.get(parsed.id) : undefined;
    if (!parsed || !entry || entry.expires < Date.now()) {
      await ctx.answerCallbackQuery({ text: NOT_PENDING }).catch(() => {});
      return;
    }

    // La aprobación pertenece a UN chat: un botón pulsado desde otro chat (aunque
    // sea de un usuario permitido) no la resuelve ni la consume.
    // Sin mensaje original (Telegram lo da como inaccesible, p. ej. muy antiguo o
    // borrado) no se puede saber desde qué chat se pulsó: se rechaza en vez de
    // saltarse la comprobación.
    const pressedIn = ctx.callbackQuery?.message?.chat?.id;
    if (pressedIn === undefined || entry.chatId !== String(pressedIn)) {
      handlers.log('warn', 'approval pressed from another chat', { id: parsed.id });
      await ctx.answerCallbackQuery({ text: NOT_PENDING }).catch(() => {});
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

  async #onTvPress(
    ctx: Context,
    handlers: ChannelHandlers,
    data: string,
    userId: number,
  ): Promise<void> {
    const chatId = ctx.callbackQuery?.message?.chat?.id;
    // Sin chat de origen no se puede comprobar «en privado»: no se ejecuta.
    if (chatId === undefined || !handlers.onTvButton) {
      await ctx.answerCallbackQuery({ text: TV_BUTTON_STALE }).catch(() => {});
      return;
    }
    const run = handlers
      .onTvButton({
        channel: 'telegram',
        chatId: String(chatId),
        userId: String(userId),
        data: data.slice(0, 64),
      })
      .catch(() => {
        handlers.log('warn', 'tv button failed', { data: data.slice(0, 64) });
        return 'No he podido mandar la orden a la tele.';
      });
    // Telegram solo acepta el aviso del botón durante unos segundos («query is too
    // old»), y una orden lenta (encender por WoL, PA_TV_CMD_TIMEOUT_MS hasta 60 s)
    // lo perdería. Si la orden no acaba enseguida, se avisa ya y el resultado va
    // como mensaje al mismo chat.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const quick = await Promise.race([
      run,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TV_BUTTON_ACK_MS);
      }),
    ]);
    clearTimeout(timer);
    // Respuesta rápida y corta: en el aviso del botón. Una larga (p. ej. «Estado»)
    // no cabe en el aviso (200 caracteres), así que va entera como mensaje.
    if (quick !== null && quick.length <= TV_BUTTON_NOTICE_MAX) {
      await ctx.answerCallbackQuery({ text: quick, show_alert: quick.length > 60 }).catch(() => {});
      return;
    }
    await ctx
      .answerCallbackQuery(quick === null ? { text: TV_BUTTON_SENDING } : {})
      .catch(() => {});
    const text = quick ?? (await run);
    await this.#throttled(() =>
      withTimeout(
        this.#bot.api.sendMessage(chatId, text.slice(0, 4000)),
        20_000,
        'sendMessage timed out',
      ),
    ).catch(() => {
      handlers.log('warn', 'tv button result not sent', { data: data.slice(0, 64) });
    });
  }

  /**
   * Pulsación de un área de /funciones: edita el mensaje con el texto del área y
   * sus botones. Si no se puede editar (mensaje viejo o borrado), lo manda nuevo.
   */
  async #onFuncionesPress(
    ctx: Context,
    handlers: ChannelHandlers,
    data: string,
    userId: number,
  ): Promise<void> {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.callbackQuery?.message?.chat?.id;
    const messageId = ctx.callbackQuery?.message?.message_id;
    if (chatId === undefined || !handlers.onFuncionesButton) return;
    const view = await handlers
      .onFuncionesButton({
        channel: 'telegram',
        chatId: String(chatId),
        userId: String(userId),
        data: data.slice(0, 64),
      })
      .catch(() => null);
    if (!view) {
      handlers.log('warn', 'funciones button failed', { data: data.slice(0, 64) });
      return;
    }
    const text = view.text.slice(0, 4000);
    const reply_markup = view.buttons.length ? buildKeyboard(view.buttons) : undefined;
    if (messageId !== undefined) {
      const edited = await this.#throttled(() =>
        withTimeout(
          this.#bot.api.editMessageText(chatId, messageId, text, { reply_markup }),
          20_000,
          'editMessageText timed out',
        ),
      ).then(
        () => true,
        () => false,
      );
      if (edited) return;
    }
    await this.#throttled(() =>
      withTimeout(
        this.#bot.api.sendMessage(chatId, text, { reply_markup }),
        20_000,
        'sendMessage timed out',
      ),
    ).catch(() => {
      handlers.log('warn', 'funciones button result not sent', { data: data.slice(0, 64) });
    });
  }

  /**
   * Pulsación de «📖 Ver todo» bajo una respuesta recortada: quita el botón (sirve
   * una vez, como «más») y manda la respuesta completa al mismo chat. Si ya no está
   * (caducó, o se pidió antes con «más»), lo dice en el aviso del botón y no envía
   * nada. Un botón pulsado desde otro chat no entrega el texto.
   */
  async #onMorePress(ctx: Context, token: string): Promise<void> {
    const message = ctx.callbackQuery?.message;
    const entry = takeMoreToken(token);
    if (message) {
      await this.#throttled(() =>
        withTimeout(
          this.#bot.api.editMessageReplyMarkup(message.chat.id, message.message_id, {
            reply_markup: { inline_keyboard: [] },
          }),
          20_000,
          'editMessageReplyMarkup timed out',
        ),
      ).catch(() => {});
    }
    const pressedIn = message?.chat?.id;
    const full =
      entry && pressedIn !== undefined && entry.chatId === String(pressedIn)
        ? takeFullReply(entry.threadKey)
        : null;
    if (!entry || !full) {
      await ctx.answerCallbackQuery({ text: MORE_GONE }).catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    // Responder al texto completo debe seguir el hilo del recorte: cada trozo enviado
    // se registra como alias del mensaje recortado, que el CLI sí conoce.
    const trimmedId = message ? String(message.message_id) : undefined;
    await this.send(
      {
        channel: this.name,
        account: this.account,
        chatId: entry.chatId,
        threadId: entry.threadId,
        replyToMessageId: trimmedId,
        text: cleanForTelegram(stripVoicePrefix(full), { keepMarks: true }),
        format: 'marks',
      },
      (id) => {
        if (trimmedId) this.#aliasReply(entry.chatId, id, trimmedId);
      },
    );
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
    opts?: { askScope?: boolean; threadId?: string },
  ): Promise<ApprovalChoice> {
    return new Promise<ApprovalChoice>((resolve) => {
      let settled = false;
      let expired = false;
      let messageId: string | null = null;
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
        if (settled) return;
        // La aprobación se resuelve ya para no retener el turno; el aviso visual
        // se pinta en segundo plano y puede llegar un instante después.
        expired = true;
        this.#approvals.delete(id);
        settle({ approved: false, scope: 'once' });
        if (messageId) void this.#markApprovalExpired(chatId, messageId);
      }, this.#options.approvalTtlMs).unref();

      // The question embeds the gate's `reason`, which may quote a credential the
      // tool was about to touch. Redaction is the codebase's scrub for exactly
      // that, and it is why the question itself is never logged any other way.
      log.debug('approval offered', { id, chatId, ...redact({ question }) });

      void this.send({
        channel: this.name,
        account: this.account,
        chatId,
        threadId: opts?.threadId,
        text: question,
        buttons: opts?.askScope
          ? [
              { label: '✅ Una vez', action: `approve:once:${id}` },
              { label: '🕒 Esta sesión', action: `approve:session:${id}` },
              { label: '♾️ Siempre', action: `approve:always:${id}` },
              { label: '❌ Denegar', action: `deny:${id}` },
            ]
          : [
              { label: '✅ Permitir', action: `approve:${id}` },
              { label: '❌ Denegar', action: `deny:${id}` },
            ],
      })
        .then((sentId) => {
          messageId = sentId;
          // Si el envío terminó justo después de caducar, el mensaje no debe
          // quedarse con botones muertos: se pinta el aviso en cuanto existe.
          if (expired && sentId) void this.#markApprovalExpired(chatId, sentId);
        })
        .catch(() => settle({ approved: false, scope: 'once' }));
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
  async send(outbound: Outbound, onSent?: (messageId: string) => void): Promise<string | null> {
    const chatId = Number(outbound.chatId);
    if (!Number.isFinite(chatId)) {
      throw new Error(`invalid telegram chat id: ${outbound.chatId}`);
    }

    let firstId: string | null = null;

    // Buttons ride on the first chunk only: repeating them on every chunk of a long
    // message would produce duplicate approvals for the same request.
    let first = true;
    const chunks = outbound.text.trim()
      ? chunkText(outbound.text, 4000, { marks: outbound.format === 'marks' })
      : [];
    for (const chunk of chunks) {
      const options = (withThread: boolean, withReply: boolean) => ({
        message_thread_id: withThread && outbound.threadId ? Number(outbound.threadId) : undefined,
        reply_to_message_id:
          withReply && outbound.replyToMessageId ? Number(outbound.replyToMessageId) : undefined,
        reply_markup:
          first && outbound.buttons?.length ? buildKeyboard(outbound.buttons) : undefined,
      });
      const rich = outbound.format === 'marks';
      let html = rich;
      const call = (withThread: boolean, withReply: boolean) =>
        this.#throttled(() =>
          withTimeout(
            this.#bot.api.sendMessage(
              chatId,
              html ? telegramHtml(chunk) : rich ? stripMarks(chunk) : chunk,
              html
                ? { ...options(withThread, withReply), parse_mode: 'HTML' as const }
                : options(withThread, withReply),
            ),
            20_000,
            'sendMessage timed out',
          ),
        );
      // Negritas reales: si Telegram rechaza el HTML («can't parse entities»), el
      // mismo trozo sale UNA vez como texto plano en vez de perder la respuesta.
      const callWithFallback = async (withThread: boolean, withReply: boolean) => {
        try {
          return await call(withThread, withReply);
        } catch (err) {
          if (!html || !isEntityParseError(err)) throw err;
          log.warn('telegram rejected the HTML, sending plain text', {
            error: describeError(err),
          });
          html = false;
          return call(withThread, withReply);
        }
      };
      let sent: Awaited<ReturnType<typeof call>>;
      try {
        sent = await callWithFallback(true, true);
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
        sent = await callWithFallback(false, false);
      }
      if (sent?.message_id) {
        const sentId = sent.message_id;
        if (first) {
          bindMoreButtons(outbound.buttons, String(chatId), () =>
            this.#clearKeyboard(chatId, sentId),
          );
        }
        onSent?.(String(sentId));
      }
      if (firstId === null && sent?.message_id) firstId = String(sent.message_id);
      first = false;
    }

    for (const image of outbound.images ?? []) {
      const sentId = await this.sendPhotoBytes(
        chatId,
        Buffer.from(image.data, 'base64'),
        outbound.threadId,
      );
      firstId ??= sentId;
    }

    if (outbound.audio) {
      const sentId = await this.#sendAudio(chatId, outbound.audio, outbound.threadId);
      firstId ??= sentId;
    }

    return firstId;
  }

  /**
   * Entrega una respuesta con texto y voz en este orden.
   *
   * El texto va primero a propósito: si la síntesis o la subida de la voz falla, el
   * usuario ya tiene la respuesta. `#sendAudio` degrada a un aviso en el log, así que
   * el id del mensaje de texto sigue siendo el valor de retorno aunque la voz falle.
   */
  async sendTextAndVoice(outbound: Outbound, audio: ChannelAudio): Promise<string | null> {
    return this.send({ ...outbound, audio });
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
    if (
      size &&
      (size.width + size.height > 10_000 ||
        size.width / size.height > 20 ||
        size.height / size.width > 20)
    ) {
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
          caption: fitCaption(`. ${Math.round(seconds)}s de microfono`),
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
   * Muestra una respuesta que va creciendo sobre un único mensaje.
   *
   * La primera llamada publica el texto con `sendMessage`; las siguientes lo editan
   * con `editMessageText`. El estado vive por chat y tema, así que el llamador solo
   * tiene que ir pasando el texto acumulado. Se escribe como mucho cada
   * `minIntervalMs` (1,2 s por defecto), nunca se reescribe el mismo texto y los dos
   * 400 esperables de una edición (sin cambios o mensaje ya no editable) se toleran
   * para no romper el turno por una diferencia cosmética.
   *
   * Devuelve el id del mensaje publicado, o null si Telegram no lo devolvió.
   */
  async streamDraft(
    chatId: number,
    threadId: string | undefined,
    text: string,
    opts?: { minIntervalMs?: number },
  ): Promise<string | null> {
    if (!Number.isFinite(chatId)) {
      throw new Error(`invalid telegram chat id: ${chatId}`);
    }
    const minIntervalMs = Math.max(0, opts?.minIntervalMs ?? DRAFT_MIN_INTERVAL_MS);

    return this.#draftGate.run(async () => {
      const key = this.#draftKey(chatId, threadId);
      const draft = this.#drafts.get(key);

      if (!draft) {
        const sent = await this.#throttled(() =>
          withTimeout(
            this.#bot.api.sendMessage(chatId, text, {
              message_thread_id: threadId ? Number(threadId) : undefined,
            }),
            20_000,
            'sendMessage timed out',
          ),
        );
        if (!sent?.message_id) return null;
        const messageId = String(sent.message_id);
        this.#drafts.set(key, { chatId, messageId, text, lastEditAt: null });
        return messageId;
      }

      if (text === draft.text) return draft.messageId;
      if (draft.lastEditAt !== null && Date.now() - draft.lastEditAt < minIntervalMs) {
        // La siguiente llamada con el texto acumulado aplicará esta versión; no se
        // guarda como aplicada para que el throttle no se coma el último cambio.
        return draft.messageId;
      }

      try {
        await this.#throttled(() =>
          withTimeout(
            this.#bot.api.editMessageText(chatId, Number(draft.messageId), text),
            20_000,
            'editMessageText timed out',
          ),
        );
      } catch (err) {
        if (!isDraftEditRefusal(err)) throw err;
      }
      draft.text = text;
      draft.lastEditAt = Date.now();
      return draft.messageId;
    });
  }

  /**
   * Cierra el borrador con la versión final, sin la cadencia de `streamDraft`.
   *
   * Sigue pasando por `#throttled` (el límite global de la Bot API) y olvida el
   * estado para que el próximo turno empiece con un mensaje nuevo. Un fallo de
   * edición se registra y no se propaga: la respuesta ya está entregada y la
   * limpieza no debe tumbar el turno.
   */
  async finishDraft(chatId: number, messageId: string, text: string): Promise<void> {
    const ref = parseMessageRef(String(chatId), messageId);
    await this.#draftGate.run(async () => {
      let unchanged = false;
      for (const [key, draft] of this.#drafts) {
        if (draft.chatId === chatId && draft.messageId === messageId) {
          unchanged = draft.text === text;
          this.#drafts.delete(key);
          break;
        }
      }
      if (!ref || unchanged) return;
      await this.#throttled(() =>
        withTimeout(
          this.#bot.api.editMessageText(ref.chatId, ref.messageId, text),
          20_000,
          'editMessageText timed out',
        ),
      ).catch((err: unknown) => {
        log.warn('draft final edit failed', { error: describeError(err) });
      });
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
          caption: fitCaption(`${caption} (${Math.round(durationSeconds)}s)`),
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
          caption: fitCaption(caption),
          message_thread_id: threadId ? Number(threadId) : undefined,
        }),
        120_000,
        'sendDocument timed out',
      ),
    );
  }

  /** Un borrador por chat y tema; el tema vacío y "General" no deben compartir burbuja. */
  #draftKey(chatId: number, threadId?: string): string {
    return `${chatId}:${threadId ?? ''}`;
  }

  /**
   * Deja constancia visible de que la aprobación caducó y retira los botones.
   *
   * Se hace en dos llamadas porque son dos operaciones distintas en la Bot API: el
   * texto pasa a "Caducada" y `editMessageReplyMarkup` con un teclado vacío borra los
   * botones. Un fallo aquí es cosmético (la aprobación ya se resolvió como denegada),
   * así que se registra y no se propaga.
   */
  async #markApprovalExpired(chatId: string, messageId: string): Promise<void> {
    const ref = parseMessageRef(chatId, messageId);
    if (!ref) return;
    await this.#throttled(() =>
      withTimeout(
        this.#bot.api.editMessageText(ref.chatId, ref.messageId, APPROVAL_EXPIRED_TEXT),
        20_000,
        'editMessageText timed out',
      ),
    ).catch((err: unknown) => {
      log.warn('approval expiry stamp failed', { error: describeError(err) });
    });
    // Los dobles de prueba antiguos no implementan este método; en el bot real
    // siempre existe. Sin la comprobación, un doble incompleto solo generaría
    // reintentos inútiles de un TypeError.
    if (typeof this.#bot.api.editMessageReplyMarkup !== 'function') return;
    await this.#throttled(() =>
      withTimeout(
        this.#bot.api.editMessageReplyMarkup(ref.chatId, ref.messageId, {
          reply_markup: { inline_keyboard: [] },
        }),
        20_000,
        'editMessageReplyMarkup timed out',
      ),
    ).catch((err: unknown) => {
      log.warn('approval expiry keyboard clear failed', { error: describeError(err) });
    });
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
          const now = Date.now();
          if (this.#cooldownUntil > deadline && this.#cooldownError) {
            // Preserve the server's cooldown without freezing the queue for longer
            // than this send can afford. Later callers fail fast until it expires.
            throw this.#cooldownError;
          }
          const wait =
            Math.max((this.#lastSentAt.get(GLOBAL_KEY) ?? 0) + MIN_GAP_MS, this.#cooldownUntil) -
            now;
          if (wait > 0) await sleep(wait);
          let value: T;
          try {
            value = await call();
          } catch (err) {
            if (err instanceof GrammyError && err.error_code === 429) {
              // Record this BEFORE releasing the gate, so an already queued call
              // cannot slip through while the failed caller schedules its retry.
              this.#cooldownUntil = Math.max(
                this.#cooldownUntil,
                Date.now() + (backoffFor(err, attempt) ?? 1_000),
              );
              this.#cooldownError = err;
            }
            throw err;
          }
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
  async #sendAudio(chatId: number, audio: ChannelAudio, threadId?: string): Promise<string | null> {
    const bytes = Buffer.from(audio.data, 'base64');
    if (bytes.length === 0) {
      log.warn('voice output rejected: empty bytes');
      return null;
    }
    const duration = audio.durationSeconds;
    const sent = await this.#throttled(() =>
      withTimeout(
        this.#bot.api.sendVoice(
          chatId,
          new InputFile(bytes, audio.mimeType === 'audio/wav' ? 'voice.wav' : 'voice.mp3'),
          {
            duration: duration && duration > 0 ? Math.ceil(duration) : undefined,
            caption: audio.durationSeconds ? `. ${Math.round(audio.durationSeconds)}s` : undefined,
            message_thread_id: threadId ? Number(threadId) : undefined,
          },
        ),
        60_000,
        'sendVoice timed out',
      ),
    ).catch((err: unknown) => {
      // The text already went out, so a failed attachment is a degraded reply rather
      // than a failed one. Log and move on.
      log.warn('voice send failed', { error: describeError(err) });
      return null;
    });
    return sent?.message_id ? String(sent.message_id) : null;
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
 *
 * The mention is matched as a whole username and case-insensitively (Telegram
 * usernames are), so `@Asistenta_bot` counts and `@asistenta_bot2` does not. A
 * reply only counts when it answers THIS bot (`botId`); a reply to any other bot
 * in the group used to start a run.
 */
export function isAddressedToBot(
  text: string,
  message: { reply_to_message?: unknown },
  botUsername: string,
  botId?: number,
): boolean {
  const name = botUsername.replace(/[^A-Za-z0-9_]/g, '');
  if (name && new RegExp(`(^|[^A-Za-z0-9_])@${name}(?![A-Za-z0-9_])`, 'i').test(text)) return true;
  const reply = message.reply_to_message as
    | { from?: { is_bot?: boolean; id?: number } }
    | undefined;
  if (reply?.from?.is_bot !== true) return false;
  return botId === undefined || reply.from.id === botId;
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

/**
 * Aviso al pulsar un botón de una aprobación que ya no espera respuesta (resuelta,
 * caducada o de otro chat). Antes salía en inglés, lo único en inglés del bot.
 */
export const NOT_PENDING = 'Esta solicitud ya no está pendiente.';

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
export function buildKeyboard(buttons: Array<{ label: string; action: string }>): InlineKeyboard {
  const kb = new InlineKeyboard();
  // Hasta dos botones van en una fila; con más, filas de dos. Los cuatro botones de
  // una aprobación en una sola fila se truncaban en el móvil («Esta se…», «Siem…») y
  // era fácil pulsar el vecino. El orden y el callback_data no cambian.
  const perRow = 2;
  buttons.forEach((b, i) => {
    if (i > 0 && i % perRow === 0) kb.row();
    kb.text(b.label, b.action);
  });
  return kb;
}

/**
 * Telegram caps a message at 4096 chars, so longer text is split.
 *
 * Antes se cortaba cada `size` puntos de código a ciegas: una respuesta larga llegaba
 * partida a mitad de palabra («recordator» / «io») o dentro de un bloque de código, y el
 * segundo mensaje empezaba con medio término. Ahora cada corte busca, por orden, el último
 * salto de párrafo, de línea, final de frase o espacio dentro de la ventana (siempre que
 * deje al menos media ventana de texto, para no generar trozos ridículos) y solo corta a
 * ciegas cuando no hay ninguno. Un bloque ``` abierto en el corte se cierra en ese mensaje
 * y se reabre en el siguiente, así ningún mensaje queda con el código a medio formatear.
 *
 * Se cuenta en puntos de código, no en unidades UTF-16: cortar a mitad de un emoji deja un
 * surrogate suelto y un carácter de reemplazo en el chat.
 */
/** Lo mínimo de la Bot API que necesita {@link configureCommandMenu}. */
export interface CommandMenuApi {
  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<unknown>;
  setChatMenuButton(opts: { menu_button: { type: 'commands' } }): Promise<unknown>;
}

/**
 * Publica el menú de comandos (en el orden de TELEGRAM_COMMANDS, que va por uso) y
 * fija el botón «Menú» junto al cuadro de texto para que abra ESA lista. Explícito:
 * si alguna vez se configuró otro botón (una web app desde BotFather), el menú
 * quedaba escondido aunque setMyCommands funcionara. Nunca lanza: un fallo aquí no
 * puede impedir que el bot arranque.
 */
export async function configureCommandMenu(api: CommandMenuApi): Promise<boolean> {
  try {
    await api.setMyCommands(TELEGRAM_COMMANDS.map((command) => ({ ...command })));
    await api.setChatMenuButton({ menu_button: { type: 'commands' } });
    return true;
  } catch (err) {
    log.warn('telegram command menu not set', { error: describeError(err) });
    return false;
  }
}

/** Telegram's 400 for markup it cannot parse (HTML parse mode). */
export function isEntityParseError(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    err.error_code === 400 &&
    /parse entities|can't find end|unsupported start tag|unexpected end tag|entity/i.test(
      err.description,
    )
  );
}

export function chunkText(text: string, size: number, opts: { marks?: boolean } = {}): string[] {
  if (Array.from(text).length <= size) return [text];
  const out: string[] = [];
  let rest = text;
  let reopen = false;
  let reopenBold = false;
  while (rest.length > 0) {
    const prefix: string = reopen ? FENCE_OPEN : reopenBold ? BOLD : '';
    if (Array.from(prefix + rest).length <= size) {
      out.push(prefix + rest);
      break;
    }
    const budget = Math.max(1, size - Array.from(prefix).length);
    let piece = splitAt(rest, budget);
    let body: string = prefix + piece.head;
    reopen = countFences(body) % 2 === 1;
    if (reopen && Array.from(prefix).length + FENCE_CLOSE.length < size) {
      // Hace falta cerrar el bloque: vuelve a cortar dejando sitio para el cierre.
      piece = splitAt(rest, Math.max(1, budget - FENCE_CLOSE.length));
      body = prefix + piece.head;
      reopen = countFences(body) % 2 === 1;
      if (reopen) body += FENCE_CLOSE;
    } else {
      reopen = false;
    }
    // Con marcas (HTML), una **negrita** partida a mitad de línea se cierra al final
    // de este trozo y se reabre en el siguiente; si no, cada trozo pierde la suya.
    reopenBold = false;
    if (opts.marks && !reopen && piece.midLine && boldOpen(body)) {
      if (Array.from(body).length + BOLD.length > size) {
        piece = splitAt(rest, Math.max(1, budget - BOLD.length));
        body = prefix + piece.head;
      }
      if (piece.midLine && boldOpen(body) && countFences(body) % 2 === 0) {
        body = body.endsWith(BOLD) ? body.slice(0, -BOLD.length) : body + BOLD;
        reopenBold = true;
      }
    }
    if (body.trim()) out.push(body);
    rest = piece.rest;
  }
  return out;
}

const BOLD = '**';

/** ¿Queda un `**` sin pareja en la última línea (fuera de bloques y de `código`)? */
function boldOpen(text: string): boolean {
  if (countFences(text) % 2 === 1) return false;
  const last = text.slice(text.lastIndexOf('\n') + 1);
  const marks = last.replace(/`[^`\n]+`/g, '').match(/\*\*/g) ?? [];
  return marks.length % 2 === 1;
}

const FENCE_OPEN = '```\n';
const FENCE_CLOSE = '\n```';

function countFences(text: string): number {
  return (text.match(/^```/gmu) ?? []).length;
}

/**
 * Corta `text` en un trozo de como mucho `budget` puntos de código y el resto.
 *
 * Prefiere, por orden, salto de párrafo, salto de línea, fin de frase y espacio, siempre
 * que el trozo conserve al menos media ventana; si no hay ninguno, corta a ciegas.
 */
function splitAt(text: string, budget: number): { head: string; rest: string; midLine: boolean } {
  const points = Array.from(text);
  const window = points.slice(0, budget + 1).join('');
  const minimum = Math.floor(budget / 2);
  const rules: Array<{ pattern: RegExp; after: boolean }> = [
    { pattern: /\n[ \t]*\n/gu, after: false },
    { pattern: /\n/gu, after: false },
    { pattern: /[.!?…:;](?=\s)/gu, after: true },
    { pattern: /\s/gu, after: false },
  ];
  let cut = budget;
  for (const { pattern, after } of rules) {
    let best = -1;
    for (const match of window.matchAll(pattern)) {
      const at = Array.from(window.slice(0, match.index ?? 0)).length + (after ? 1 : 0);
      if (at <= budget && at >= minimum && at > 0) best = at;
    }
    if (best > 0) {
      cut = best;
      break;
    }
  }
  const head = points.slice(0, cut).join('').replace(/\s+$/u, '');
  const tail = points.slice(cut).join('');
  // El separador se queda en el corte: sin líneas en blanco ni espacio inicial en el
  // siguiente mensaje, pero conservando la sangría de la primera línea real.
  const rest = tail.replace(/^(?:[ \t]*\r?\n)+/u, '').replace(/^ (?=\S)/u, '');
  // midLine: el corte no cae en un salto de línea (la línea sigue en el próximo trozo).
  const midLine = cut < points.length && !/^[ \t]*\r?\n/u.test(tail);
  return { head: head || points.slice(0, cut).join(''), rest, midLine };
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

/** Tope de Telegram para el pie de un archivo, en unidades UTF-16 (como cuenta Telegram). */
export const CAPTION_MAX = 1024;

/**
 * Pie de archivo dentro del tope de Telegram.
 *
 * Antes se cortaba con slice a 1024 a ciegas: cortaba a media palabra sin avisar y podía partir
 * un emoji (par sustituto) y dejar medio carácter, que Telegram rechaza o pinta como
 * «�». Ahora corta en el último espacio de la ventana (si no queda demasiado corto),
 * nunca parte un par sustituto y termina en «…» para que se vea que falta algo.
 */
export function fitCaption(text: string, max = CAPTION_MAX): string {
  if (text.length <= max) return text;
  let cut = max - 1; // sitio para «…»
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // no dejar medio emoji
  const space = text.lastIndexOf(' ', cut);
  if (space > max * 0.8) cut = space;
  return `${text.slice(0, cut).trimEnd()}…`;
}

/** Prefijo del callback de «📖 Ver todo»; nunca empieza como approve:/deny:. */
export const MORE_CALLBACK_PREFIX = 'more:';

/** Tiempo que se espera a la orden antes de contestar «Enviando…» al botón. */
const TV_BUTTON_ACK_MS = 2500;
/** Lo que cabe en el aviso de un botón (Telegram corta en 200). */
const TV_BUTTON_NOTICE_MAX = 190;
const TV_BUTTON_SENDING = 'Enviando a la tele…';
const TV_BUTTON_STALE = 'Este botón ya no sirve. Escribe /tv para sacar el mando.';
export const MORE_BUTTON_LABEL = '📖 Ver todo';
const MORE_GONE = 'Ya no tengo el texto completo. Pídemelo otra vez.';

interface MoreToken {
  threadKey: string;
  chatId: string;
  threadId?: string;
  expires: number;
  /** Quita el botón del mensaje recortado; lo pone el canal al enviarlo. */
  retire?: () => void;
}

/**
 * La copia completa de `threadKey` se ha usado («más» escrito) o sustituido (otra
 * respuesta): sus botones «📖 Ver todo» ya solo dirían «Ya no tengo el texto», así
 * que se retiran del chat y sus fichas se invalidan.
 */
function retireMoreButtons(threadKey: string): void {
  for (const [token, entry] of moreTokens) {
    if (entry.threadKey !== threadKey) continue;
    moreTokens.delete(token);
    entry.retire?.();
  }
}

/** Liga las fichas «more:» de `buttons` al mensaje que las lleva (para poder retirarlas). */
function bindMoreButtons(
  buttons: ReadonlyArray<{ action: string }> | undefined,
  chatId: string,
  retire: () => void,
): void {
  for (const button of buttons ?? []) {
    if (!button.action.startsWith(MORE_CALLBACK_PREFIX)) continue;
    const entry = moreTokens.get(button.action.slice(MORE_CALLBACK_PREFIX.length));
    if (entry && entry.chatId === chatId) entry.retire = retire;
  }
}

/** Fichas cortas de botón → hilo: la clave del hilo no cabe (ni debe ir) en los 64 bytes del callback. */
const moreTokens = new Map<string, MoreToken>();

/**
 * Botón «📖 Ver todo» para una respuesta recortada de `threadKey`. Caduca con la
 * copia completa (mismo TTL y mismo tope) y solo vale en el chat donde se envió.
 */
export function moreButton(
  threadKey: string,
  chatId: string,
  threadId?: string,
): { label: string; action: string } {
  const now = Date.now();
  for (const [key, entry] of moreTokens) {
    if (entry.expires <= now) moreTokens.delete(key);
  }
  const token = randomBytes(6).toString('base64url');
  moreTokens.set(token, { threadKey, chatId, threadId, expires: now + FULL_REPLY_TTL_MS });
  while (moreTokens.size > FULL_REPLY_MAX_ENTRIES) {
    const oldest = moreTokens.keys().next();
    if (oldest.done) break;
    moreTokens.delete(oldest.value);
  }
  return { label: MORE_BUTTON_LABEL, action: `${MORE_CALLBACK_PREFIX}${token}` };
}

/** Retira la ficha (un solo uso); null si no existe o caducó. */
function takeMoreToken(token: string): MoreToken | null {
  const entry = moreTokens.get(token);
  if (!entry) return null;
  moreTokens.delete(token);
  return entry.expires > Date.now() ? entry : null;
}

/** Respuestas completas recientes, para servir "Dime más" sin volver a ejecutar. */
const fullReplies = new Map<string, CachedReply>();

/**
 * Guarda la respuesta completa de un hilo.
 *
 * El mensaje de Telegram puede ir recortado, así que el CLI conserva aquí el texto
 * entero y lo sirve cuando el usuario pide el detalle. Se purgan las entradas
 * caducadas y se expulsa la más antigua al superar el tope; 24 respuestas bastan
 * para los hilos que un humano puede estar leyendo a la vez.
 */
export function cacheFullReply(threadKey: string, text: string): void {
  const now = Date.now();
  for (const [key, entry] of fullReplies) {
    if (entry.expires <= now) fullReplies.delete(key);
  }
  // Reinsertar refresca el orden de expulsión: la entrada vuelve a ser la más nueva.
  // La copia anterior se pierde: su botón ya no sirve.
  if (fullReplies.delete(threadKey)) retireMoreButtons(threadKey);
  fullReplies.set(threadKey, { text, expires: now + FULL_REPLY_TTL_MS });
  while (fullReplies.size > FULL_REPLY_MAX_ENTRIES) {
    const oldest = fullReplies.keys().next();
    if (oldest.done) break;
    fullReplies.delete(oldest.value);
  }
}

/**
 * Retira y devuelve la respuesta completa de un hilo, o null si no existe o caducó.
 *
 * Es destructivo a propósito: "Dime más" consume la respuesta una vez, igual que el
 * mensaje recortado que la ofrecía. Una segunda petición no puede repetir un texto
 * que ya se mostró por error.
 */
export function takeFullReply(threadKey: string): string | null {
  const entry = fullReplies.get(threadKey);
  if (!entry) return null;
  fullReplies.delete(threadKey);
  retireMoreButtons(threadKey);
  return entry.expires > Date.now() ? entry.text : null;
}

/** Peticiones que significan "sigue con el resto", ya sin acentos ni mayúsculas. */
const MORE_REQUEST = /\b(?:mas|detalles?|sigue|continua|el resto)\b/;

/**
 * Palabras que caben en una petición de «el resto» y nada más. Si el mensaje trae
 * otra palabra («sigue BUSCANDO vuelos», «pon la música MÁS alta»), es un encargo
 * nuevo y tiene que llegar al agente, no reenviar la respuesta anterior.
 */
const MORE_FILLER = new Set([
  'mas',
  'detalle',
  'detalles',
  'sigue',
  'continua',
  'el',
  'resto',
  'dime',
  'dame',
  'cuentame',
  'quiero',
  'por',
  'favor',
  'porfa',
  'y',
  'venga',
  'vale',
  'ok',
  'todo',
  'lo',
  'la',
  'respuesta',
  'completa',
  'entera',
  'ver',
  'manda',
  'mandame',
  'pasame',
]);

/**
 * ¿El mensaje pide el resto de una respuesta recortada?
 *
 * Se normaliza a minúsculas y sin diacríticos para que "más", "MAS" y "mas" sean la
 * misma petición. Las fronteras de palabra evitan que "demasiado" o "detallado"
 * disparen la caché por accidente. Y el mensaje entero tiene que ser la petición
 * (como mucho 6 palabras, todas de MORE_FILLER): antes bastaba con que apareciera
 * «más» o «sigue» en cualquier frase, y «sigue buscando vuelos» reenviaba la
 * respuesta anterior en vez de hacer el encargo.
 */
export function isMoreRequest(text: string): boolean {
  const plain = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
  if (!MORE_REQUEST.test(plain)) return false;
  const words = plain.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length <= 6 && words.every((w) => MORE_FILLER.has(w));
}
