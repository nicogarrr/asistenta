/**
 * Read an answer out loud on this machine's speakers, phrase by phrase,
 * interruptible (capability 6, V2).
 *
 * Extracted from the daemon wiring so the production pipeline is testable:
 * synthesis (SAPI) and playback (MCI) are injected, and the SpeakControl's
 * abort signal reaches the synthesis itself. Before this module existed the
 * runner lived inline in cli.ts and the signal stopped at the playback: a
 * barge-in silenced the speaker but the in-flight synthesis of the next
 * phrase ran to completion anyway, delaying the answer to the interruption
 * by seconds on a slow machine. The SpeakControl contract ("pásala a
 * speakChunked... para cortar la síntesis en curso") now holds here too.
 *
 * Never touches the system volume: a conversation must not.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpeakControl } from './conversation.js';
import { speakPhrases } from './phrases.js';
import type { Playback, Speaker } from './speaker.js';
import type { Tts } from './tts.js';

export interface AloudSpeakerDeps {
  tts: Tts;
  speaker: Speaker;
  /** Scratch directory for the per-phrase mp3s; created when missing. */
  directory: string;
  /** False once the owning session closed or was replaced: nothing more is said. */
  isOwnerCurrent: () => boolean;
  /** Hands the live playback to the owner, so a close can stop it. */
  setPlayback: (playback: Playback | null) => void;
}

export interface AloudSpeaker {
  /** Speak the phrases under the session's control. Resolves when done or cut. */
  run(ctl: SpeakControl): Promise<void>;
  /** Stop the sound and drop everything pending. Idempotent. */
  abort(): void;
}

export function createAloudSpeaker(phrases: string[], deps: AloudSpeakerDeps): AloudSpeaker {
  let handle: ReturnType<typeof speakPhrases> | null = null;
  let n = 0;
  return {
    abort: () => handle?.abort(),
    async run(ctl: SpeakControl): Promise<void> {
      if (phrases.length === 0 || !deps.isOwnerCurrent()) return;
      mkdirSync(deps.directory, { recursive: true });
      handle = speakPhrases(phrases, {
        synth: async (phrase) => {
          // The SpeakControl signal reaches SAPI: a barge-in (or the session
          // closing) cuts the in-flight synthesis too, not just the speaker.
          const spoken = await deps.tts.speak(phrase, { signal: ctl.signal });
          // Closed, switched off or replaced while synthesising: nothing more is said.
          if (!deps.isOwnerCurrent()) throw new Error('sesión cerrada');
          const file = join(deps.directory, `say-${Date.now()}-${n++}.mp3`);
          writeFileSync(file, spoken.data);
          return file;
        },
        play: (file) => {
          const playback = deps.speaker.play(file);
          deps.setPlayback(playback);
          return playback;
        },
        remove: (file) => rmSync(file, { force: true }),
        onPhraseStart: () => ctl.phraseStart(),
      });
      try {
        const result = await handle.done;
        if (!result.aborted && result.spoken < phrases.length) {
          throw new Error('no he podido leer toda la respuesta en voz alta');
        }
      } catch (err) {
        // Aborted on purpose (barge-in / close): not a failure worth reporting.
        if (!ctl.interrupted() && deps.isOwnerCurrent()) throw err;
      } finally {
        deps.setPlayback(null);
      }
    },
  };
}
