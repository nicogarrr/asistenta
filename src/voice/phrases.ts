/**
 * Spoken answers, phrase by phrase (capability 6, V2).
 *
 * `splitPhrases` cuts text at sentence ends so the first sentence can sound while the
 * rest is still being synthesised; `speakPhrases` runs that pipeline (one phrase
 * synthesising ahead of the one playing) and can be aborted at any moment, which is
 * what barge-in needs. Synthesis and playback are injected.
 */

import type { Playback } from './speaker.js';

const MAX_PHRASE = 240;
const MIN_PHRASE = 28;

/** Sentences of at most MAX_PHRASE characters; tiny ones are merged into their neighbour. */
export function splitPhrases(text: string): string[] {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  const sentences = flat.match(/[^.!?…]+(?:[.!?…]+|$)\s*/g)?.map((x) => x.trim()) ?? [flat];
  const pieces: string[] = [];
  for (const sentence of sentences) {
    let rest = sentence;
    while (rest.length > MAX_PHRASE) {
      const window = rest.slice(0, MAX_PHRASE);
      const cut = Math.max(
        window.lastIndexOf(', '),
        window.lastIndexOf('; '),
        window.lastIndexOf(': '),
      );
      const at =
        cut > MAX_PHRASE / 3
          ? cut + 1
          : window.lastIndexOf(' ') > 0
            ? window.lastIndexOf(' ')
            : MAX_PHRASE;
      pieces.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) pieces.push(rest);
  }
  const merged: string[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (
      last !== undefined &&
      (last.length < MIN_PHRASE || piece.length < MIN_PHRASE) &&
      last.length + piece.length + 1 <= MAX_PHRASE
    ) {
      merged[merged.length - 1] = `${last} ${piece}`;
    } else {
      merged.push(piece);
    }
  }
  return merged;
}

export interface PhraseRunner {
  /** Synthesise one phrase to a playable file path. */
  synth(text: string): Promise<string>;
  play(file: string): Playback;
  remove(file: string): void;
  /** Called when a phrase starts to sound. */
  onPhraseStart?: () => void;
}

export interface PhraseHandle {
  /** Stop the sound and drop everything pending. Idempotent. */
  abort(): void;
  done: Promise<{ spoken: number; aborted: boolean }>;
}

/**
 * Speak phrases in order. The next phrase is synthesised while the current one plays.
 * A failure on the first phrase rejects (nothing was said); a later failure ends the
 * speech early and rejects too, after cleaning up. Every temporary file is removed,
 * including ones finished after an abort.
 */
export function speakPhrases(phrases: string[], runner: PhraseRunner): PhraseHandle {
  let aborted = false;
  let current: Playback | null = null;
  const abort = (): void => {
    aborted = true;
    current?.stop();
  };
  const done = (async () => {
    let spoken = 0;
    const files: Array<Promise<string> | null> = phrases.map(() => null);
    const start = (i: number): void => {
      if (i < phrases.length && !files[i]) {
        const p = runner.synth(phrases[i] as string);
        // Never an unhandled rejection for a phrase we abandon.
        p.catch(() => {});
        files[i] = p;
      }
    };
    start(0);
    try {
      for (let i = 0; i < phrases.length; i++) {
        start(i + 1);
        const file = await files[i];
        if (aborted || !file) break;
        const playback = runner.play(file);
        current = playback;
        runner.onPhraseStart?.();
        try {
          await playback.done;
        } finally {
          current = null;
          runner.remove(file);
          files[i] = null;
        }
        spoken++;
        if (aborted) break;
      }
    } finally {
      // Phrases synthesised ahead and never played: delete their files once they land.
      for (const pending of files) {
        if (pending)
          void pending.then(
            (f) => runner.remove(f),
            () => {},
          );
      }
    }
    return { spoken, aborted };
  })();
  return { abort, done };
}
