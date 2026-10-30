import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uniqueTmpPath } from '../fs-tmp.js';
/** Audio handles and optional local originals, isolated per chat and bounded by
 * the same TTL and per-chat cap. The local original survives a daemon restart
 * so replay does not depend on another Telegram download. */

/** One audio the user sent, as far as we still care about it. */
export interface ReceivedAudio {
  /** Telegram `file_id`. Stable, re-downloadable, and nothing more. */
  fileId: string;
  /** The codec Telegram reported, because it decides whether we can transcode. */
  mimeType: string;
  /** The message it arrived on, so a reply to it can find it again. */
  messageId: string;
  /** Epoch ms. Drives both the TTL and the "how long ago" text. */
  at: number;
  durationSeconds?: number;
  /** Filled in once the note has been through whisper. */
  transcript?: string;
  /** What the user typed alongside it, if anything: a caption is often the request. */
  caption?: string;
}

export interface AudioRecallOptions {
  directory?: string;
  /** Audios kept per chat. */
  perChat?: number;
  /** How long an audio stays eligible. */
  ttlMs?: number;
  /** Injected clock, so the TTL is testable without sleeping. */
  now?: () => number;
}

/** Two hours. Long enough for a whole evening of "suéltalo", short enough to be honest. */
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
/** Generous for one person; a group would need a real policy, not a bigger number. */
const DEFAULT_PER_CHAT = 10;

export class AudioRecall {
  #expiryTimer?: ReturnType<typeof setTimeout>;
  readonly #directory?: string;
  readonly #perChat: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  /** chatKey -> newest first. */
  readonly #byChat = new Map<string, ReceivedAudio[]>();

  constructor(opts: AudioRecallOptions = {}) {
    this.#perChat = Math.max(1, Math.trunc(opts.perChat ?? DEFAULT_PER_CHAT));
    this.#ttlMs = Math.max(0, Math.trunc(opts.ttlMs ?? DEFAULT_TTL_MS));
    this.#now = opts.now ?? Date.now;
    this.#directory = opts.directory;
    if (this.#directory) {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      try {
        const saved = JSON.parse(
          readFileSync(join(this.#directory, 'index.json'), 'utf8'),
        ) as Array<[string, ReceivedAudio[]]>;
        for (const [chat, entries] of saved) {
          if (typeof chat === 'string' && Array.isArray(entries)) {
            const valid = entries.filter(
              (a) =>
                typeof a.messageId === 'string' &&
                typeof a.fileId === 'string' &&
                typeof a.mimeType === 'string' &&
                Number.isFinite(a.at),
            );
            this.#byChat.set(chat, valid);
            this.#prune(valid, chat);
            while (valid.length > this.#perChat) {
              const removed = valid.pop();
              if (removed) this.#remove(chat, removed.messageId);
            }
          }
        }
      } catch {
        /* No index yet, or corrupt index: do not expose guessed audio. */
      }
    }
    this.#sweep();
  }

  /**
   * Remember an incoming audio. Re-recording the same message is idempotent, which
   * matters because the adapter is at-least-once and the daemon drops duplicates
   * further up; a redelivery must not push the same note down the list.
   */
  record(chatKey: string, audio: Omit<ReceivedAudio, 'at'> & { at?: number }): ReceivedAudio {
    this.#sweep();
    const entry: ReceivedAudio = { ...audio, at: audio.at ?? this.#now() };
    const list = this.#writable(chatKey);
    const existing = list.findIndex((a) => a.messageId === entry.messageId);
    if (existing >= 0) {
      // Keep whatever we already learned (a transcript) and only refresh the handle.
      const merged = { ...list[existing], ...entry } as ReceivedAudio;
      list.splice(existing, 1);
      list.unshift(merged);
      this.#save();
      this.#scheduleExpiry();
      return merged;
    }
    list.unshift(entry);
    while (list.length > this.#perChat) {
      const removed = list.pop();
      if (removed) this.#remove(chatKey, removed.messageId);
    }
    this.#save();
    this.#scheduleExpiry();
    return entry;
  }

  /** Attach a transcript to an audio already remembered, matched by message id. */
  setTranscript(chatKey: string, messageId: string, transcript: string): void {
    for (const audio of this.#live(chatKey)) {
      if (audio.messageId === messageId) {
        audio.transcript = transcript;
        this.#save();
        return;
      }
    }
  }

  /** Newest eligible audio in the chat, or null when there is none. */
  last(chatKey: string): ReceivedAudio | null {
    return this.#live(chatKey)[0] ?? null;
  }

  byMessage(chatKey: string, messageId: string): ReceivedAudio | null {
    if (!messageId) return null;
    return this.#live(chatKey).find((a) => a.messageId === messageId) ?? null;
  }

  /** Newest first — by arrival, which is the same as by age because `at` is read off
   * one clock inside `record`. For the model to describe when the user asks what they
   * sent. */
  list(chatKey: string): ReceivedAudio[] {
    return [...this.#live(chatKey)];
  }

  /**
   * Pick the audio a request refers to.
   *
   * `own` is the audio on the message being answered, which wins over history: if
   * the user sent a note and then typed "suéltalo" on the next message, the note
   * they just sent is the one they mean, not the previous one. `replyTo` is the
   * message they replied to, which is the other way of pointing at a specific note.
   */
  resolve(chatKey: string, opts: { own?: string; replyTo?: string } = {}): ReceivedAudio | null {
    if (opts.own) {
      const own = this.byMessage(chatKey, opts.own);
      if (own) return own;
    }
    if (opts.replyTo) {
      const replied = this.byMessage(chatKey, opts.replyTo);
      if (replied) return replied;
    }
    return this.last(chatKey);
  }

  /** Chats with something remembered. Used by diagnostics, not by the model. */
  get chats(): number {
    return this.#byChat.size;
  }

  /**
   * The clock this registry judges ages by.
   *
   * Exposed so a caller describing an audio ("recibido hace 3 min") measures against
   * the same clock that decides whether the audio is still eligible. Two clocks would
   * let the registry hand back an entry that its own text then describes as being from
   * next year.
   */
  now(): number {
    return this.#now();
  }

  get size(): number {
    let total = 0;
    for (const list of this.#byChat.values()) total += list.length;
    return total;
  }

  /**
   * The stored list, pruned. Reads go through here rather than straight off the map
   * so an expired entry is never handed out, and the pruning is what stops the map
   * from holding one list per chat the daemon has ever seen.
   *
   * Does not create a list for an unknown chat: a reader asking about a chat nobody
   * has spoken in should not allocate anything.
   */
  #scheduleExpiry(): void {
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    let earliest = Infinity;
    for (const list of this.#byChat.values())
      for (const a of list) earliest = Math.min(earliest, a.at + this.#ttlMs);
    if (earliest !== Infinity) {
      this.#expiryTimer = setTimeout(() => this.#sweep(), Math.max(1, earliest - this.#now() + 1));
      this.#expiryTimer.unref?.();
    }
  }
  #sweep(): void {
    for (const [chat, list] of this.#byChat) this.#prune(list, chat);
    if (this.#directory) {
      const expected = new Set<string>();
      for (const [chat, list] of this.#byChat)
        for (const a of list) {
          const path = this.#path(chat, a.messageId);
          if (path) expected.add(path);
        }
      for (const name of readdirSync(this.#directory)) {
        const path = join(this.#directory, name);
        if (name.endsWith('.audio') && !expected.has(path)) rmSync(path, { force: true });
      }
      this.#save();
    }
    this.#scheduleExpiry();
  }

  #path(chat: string, message: string): string | null {
    if (!this.#directory) return null;
    return join(
      this.#directory,
      `${createHash('sha256').update(`${chat}\0${message}`).digest('hex')}.audio`,
    );
  }
  #remove(chat: string, message: string): void {
    const path = this.#path(chat, message);
    if (path) rmSync(path, { force: true });
  }
  #save(): void {
    if (!this.#directory) return;
    const path = join(this.#directory, 'index.json');
    const tmp = uniqueTmpPath(path);
    try {
      writeFileSync(tmp, JSON.stringify([...this.#byChat]), { mode: 0o600 });
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }
  retain(chat: string, message: string, bytes: Buffer): void {
    if (!this.byMessage(chat, message) || bytes.length === 0 || bytes.length > 25_000_000) return;
    const path = this.#path(chat, message);
    if (path) writeFileSync(path, bytes, { mode: 0o600 });
  }
  read(chat: string, message: string): Buffer | null {
    if (!this.byMessage(chat, message)) return null;
    const path = this.#path(chat, message);
    try {
      return path ? readFileSync(path) : null;
    } catch {
      return null;
    }
  }

  #live(chatKey: string): ReceivedAudio[] {
    const list = this.#byChat.get(chatKey);
    if (!list) return [];
    this.#prune(list, chatKey);
    return list;
  }

  /** As `#live`, but attaches a list when the chat is new. Writers only. */
  #writable(chatKey: string): ReceivedAudio[] {
    const existing = this.#byChat.get(chatKey);
    if (existing) {
      this.#prune(existing, chatKey);
      this.#byChat.set(chatKey, existing);
      return existing;
    }
    const list: ReceivedAudio[] = [];
    this.#byChat.set(chatKey, list);
    return list;
  }

  #prune(list: ReceivedAudio[], chatKey: string): void {
    const cutoff = this.#now() - this.#ttlMs;
    while (list.length && (list[list.length - 1]?.at ?? 0) < cutoff) {
      const removed = list.pop();
      if (removed) this.#remove(chatKey, removed.messageId);
    }
    if (!list.length) this.#byChat.delete(chatKey);
  }
}

/**
 * "hace 3 min", for telling the user which audio is about to play.
 *
 * Deliberately coarse and in Spanish, because it is read by the model and quoted to
 * the user, not parsed by anything. A minute-resolution string is enough to say
 * "this is the one from five minutes ago" without pretending to be precise.
 */
export function agoLabel(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'ahora mismo';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `hace ${hours} h`;
}
