import { readFileSync } from 'node:fs';
import { writeFileReplacing } from './fs-tmp.js';
import { log } from './log.js';

/**
 * A one-time reminder that could not be delivered for an hour (no internet,
 * Telegram down) is dropped and noted in `dropped-reminders.jsonl`. Before this,
 * the owner only learnt about it if he asked for /estado. Now, once sending works
 * again, he gets ONE plain message per chat listing what was missed, and each
 * entry is marked as told so it is never repeated. The file is also trimmed to
 * the newest entries, so it cannot grow without bound over months.
 */

interface Entry {
  at?: number;
  text?: string;
  chat?: string;
  told?: boolean;
}

/** Entries older than this are not worth a late message any more. */
export const DROPPED_NOTICE_MAX_AGE_MS = 7 * 86_400_000;
/** Lines kept in the file when it is rewritten. */
export const DROPPED_KEEP = 50;
/** How often the daemon looks for something to tell. */
export const DROPPED_NOTICE_EVERY_MS = 5 * 60_000;

function read(file: string): Entry[] {
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: Entry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Entry);
    } catch {
      // half-written line
    }
  }
  return out;
}

/** The message for one chat, or null when there is nothing to tell. */
export function droppedNoticeText(texts: string[]): string | null {
  if (texts.length === 0) return null;
  if (texts.length === 1) return `No pude avisarte a tiempo (no había conexión): ${texts[0]}.`;
  return `No pude avisarte a tiempo de esto (no había conexión):\n${texts.map((t) => `• ${t}`).join('\n')}`;
}

/** What is still untold, per chat. */
export function pendingDropped(file: string, now = Date.now()): Map<string, string[]> {
  const byChat = new Map<string, string[]>();
  for (const e of read(file)) {
    if (e.told || !e.chat || typeof e.text !== 'string' || typeof e.at !== 'number') continue;
    if (now - e.at > DROPPED_NOTICE_MAX_AGE_MS) continue;
    byChat.set(e.chat, [...(byChat.get(e.chat) ?? []), e.text]);
  }
  return byChat;
}

function markTold(file: string, chats: Set<string>, now: number): void {
  const kept = read(file)
    .map((e) =>
      e.chat &&
      chats.has(e.chat) &&
      !e.told &&
      typeof e.at === 'number' &&
      now - e.at <= DROPPED_NOTICE_MAX_AGE_MS
        ? { ...e, told: true }
        : e,
    )
    .slice(-DROPPED_KEEP);
  writeFileReplacing(file, kept.length ? `${kept.map((e) => JSON.stringify(e)).join('\n')}\n` : '');
}

/**
 * Tell each chat once about reminders that were dropped. A failed send leaves
 * them pending for the next try; nothing is sent when there is nothing new.
 * Returns how many chats were told.
 */
export async function announceDropped(
  file: string,
  send: (chatId: string, text: string) => Promise<unknown>,
  now = Date.now(),
): Promise<number> {
  const told = new Set<string>();
  for (const [chat, texts] of pendingDropped(file, now)) {
    const text = droppedNoticeText(texts);
    if (!text) continue;
    try {
      await send(chat, text);
      told.add(chat);
    } catch (err) {
      log.warn('dropped reminders notice not sent yet', { err });
    }
  }
  if (told.size > 0) {
    try {
      markTold(file, told, now);
    } catch (err) {
      log.warn('dropped reminders notice could not be marked', { err });
    }
  }
  return told.size;
}
