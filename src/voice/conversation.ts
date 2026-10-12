/**
 * Spoken conversation session (capability 6, V1).
 *
 * After the wake word the user can keep talking without repeating it: this machine
 * cuts the microphone stream into utterances (energy VAD with hysteresis), turns each
 * into text, hands the text to a turn and speaks the answer, until the session closes
 * (silence, a closing phrase, /conversacion off or a failure).
 *
 * Everything with side effects is injected - transcriber, turn runner, speaker - and
 * time is the AUDIO clock (samples received), so the state machine is deterministic and
 * testable without a microphone, a model or a wall clock.
 *
 * Declared limits (V1): while the agent thinks or speaks the microphone stream is
 * dropped (no barge-in; that is V2); the VAD is energy based, so a noisy room can hold
 * an utterance open until the 30 s ceiling; whisper can invent text on noise, so empty,
 * filler-only and known-hallucination transcripts are discarded.
 *
 * Nothing here persists audio. Only the transcribed text leaves this module.
 */

export const SAMPLE_RATE = 16_000;

export type CloseReason = 'inactividad' | 'cierre' | 'apagado' | 'fallo';

export interface ConversationOptions {
  /** Speech/silence boundary, RMS of a chunk. Default 0.05 (same gate as the wake listener). */
  gateRms?: number;
  /** Speech needed before an utterance starts. Default 150 ms. */
  startMs?: number;
  /** Silence that ends an utterance. Default 900 ms. */
  endSilenceMs?: number;
  /** Hard ceiling for one utterance. Default 30 s. */
  maxUtteranceMs?: number;
  /** Audio kept from before the speech started. Default 300 ms. */
  preRollMs?: number;
  /** Voiced audio below this is a click, not speech. Default 300 ms. */
  minVoicedMs?: number;
  /** Listening time without an utterance before the session closes. Default 45 s. */
  idleMs?: number;
  /** Audio ignored after the agent stops speaking (room echo). Default 800 ms. */
  tailMs?: number;
  /** Transcription budget. Default 30 s. */
  transcribeTimeoutMs?: number;
  /** Consecutive transcription failures that close the session. Default 3. */
  maxFailures?: number;
  transcriber: (samples: Float32Array) => Promise<string>;
  /** Runs the agent turn for what was said and speaks the answer. Resolves when done. */
  onUtterance: (text: string) => Promise<void>;
  onClose: (reason: CloseReason, detail?: string) => void;
}

export type ConversationState = 'escuchando' | 'transcribiendo' | 'respondiendo' | 'cerrada';

const FILLERS = new Set([
  'eh',
  'em',
  'mm',
  'mmm',
  'ah',
  'uh',
  'um',
  'hm',
  'ajá',
  'aja',
  'oh',
  'eh eh',
]);
const HALLUCINATIONS = [
  'subtitulos por la comunidad de amara',
  'subtitulado por la comunidad de amara',
  'gracias por ver el video',
  'gracias por ver el vídeo',
  'suscribete',
  'amara org',
];
const CLOSERS = new Set([
  'adios',
  'hasta luego',
  'hasta ahora',
  'nada mas',
  'gracias nada mas',
  'ya esta',
  'ya esta gracias',
  'para',
  'para ya',
  'cierra la conversacion',
  'fin de la conversacion',
  'terminar conversacion',
  'terminamos',
]);

export function normaliseSpeech(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the utterance only closes the conversation. Exact phrases only: "para" inside a task is a task. */
export function isClosingPhrase(text: string): boolean {
  const n = normaliseSpeech(text).replace(/^(vale |bueno |ok |asistenta )+/, '');
  return CLOSERS.has(n);
}

/** True for transcripts that carry no request: empty, filler or a known whisper hallucination. */
export function isNoise(text: string): boolean {
  const n = normaliseSpeech(text);
  if (n.length < 2) return true;
  if (FILLERS.has(n)) return true;
  return HALLUCINATIONS.some((h) => n.includes(normaliseSpeech(h)));
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

const msToSamples = (ms: number): number => Math.round((ms * SAMPLE_RATE) / 1000);

export class ConversationSession {
  #o: Required<Omit<ConversationOptions, 'transcriber' | 'onUtterance' | 'onClose'>>;
  #transcriber: ConversationOptions['transcriber'];
  #onUtterance: ConversationOptions['onUtterance'];
  #onClose: ConversationOptions['onClose'];

  #state: ConversationState = 'escuchando';
  /** Audio clock: samples of listening time since the session (or the last answer) began. */
  #idleSamples = 0;
  #skipSamples = 0;
  #preRoll: Float32Array[] = [];
  #preRollSamples = 0;
  #speech: Float32Array[] = [];
  #speechSamples = 0;
  #voicedSamples = 0;
  #silentSamples = 0;
  #pendingStart = 0;
  #inSpeech = false;
  #failures = 0;
  #utterances = 0;
  #lastHeard = '';
  #lastError = '';
  #generation = 0;

  constructor(opts: ConversationOptions) {
    this.#o = {
      gateRms: opts.gateRms ?? 0.05,
      startMs: opts.startMs ?? 150,
      endSilenceMs: opts.endSilenceMs ?? 900,
      maxUtteranceMs: opts.maxUtteranceMs ?? 30_000,
      preRollMs: opts.preRollMs ?? 300,
      minVoicedMs: opts.minVoicedMs ?? 300,
      idleMs: opts.idleMs ?? 45_000,
      tailMs: opts.tailMs ?? 800,
      transcribeTimeoutMs: opts.transcribeTimeoutMs ?? 30_000,
      maxFailures: opts.maxFailures ?? 3,
    };
    this.#transcriber = opts.transcriber;
    this.#onUtterance = opts.onUtterance;
    this.#onClose = opts.onClose;
  }

  state(): ConversationState {
    return this.#state;
  }

  stats(): { state: ConversationState; utterances: number; lastHeard: string; lastError: string } {
    return {
      state: this.#state,
      utterances: this.#utterances,
      lastHeard: this.#lastHeard,
      lastError: this.#lastError,
    };
  }

  /** Close for good. Idempotent. In-flight transcriptions and turns see a closed session and drop their result. */
  close(reason: CloseReason, detail?: string): void {
    if (this.#state === 'cerrada') return;
    this.#state = 'cerrada';
    this.#generation++;
    this.#speech = [];
    this.#preRoll = [];
    try {
      this.#onClose(reason, detail);
    } catch {
      // A throwing close hook must not leave the session half closed.
    }
  }

  /** Feed microphone audio (16 kHz mono float). Audio outside 'escuchando' is dropped on purpose. */
  feed(pcm: Float32Array): void {
    if (this.#state !== 'escuchando' || pcm.length === 0) return;
    if (this.#skipSamples > 0) {
      this.#skipSamples = Math.max(0, this.#skipSamples - pcm.length);
      return;
    }
    const voiced = rms(pcm) >= this.#o.gateRms;

    if (!this.#inSpeech) {
      if (voiced) {
        this.#pendingStart += pcm.length;
        this.#pushPreRoll(pcm);
        if (this.#pendingStart >= msToSamples(this.#o.startMs)) {
          this.#inSpeech = true;
          this.#speech = [...this.#preRoll];
          this.#speechSamples = this.#preRollSamples;
          this.#voicedSamples = this.#pendingStart;
          this.#silentSamples = 0;
          this.#idleSamples = 0;
        }
      } else {
        this.#pendingStart = 0;
        this.#pushPreRoll(pcm);
        this.#idleSamples += pcm.length;
        if (this.#idleSamples >= msToSamples(this.#o.idleMs)) this.close('inactividad');
      }
      return;
    }

    this.#speech.push(pcm);
    this.#speechSamples += pcm.length;
    if (voiced) {
      this.#voicedSamples += pcm.length;
      this.#silentSamples = 0;
    } else {
      this.#silentSamples += pcm.length;
    }
    const ended = this.#silentSamples >= msToSamples(this.#o.endSilenceMs);
    const tooLong = this.#speechSamples >= msToSamples(this.#o.maxUtteranceMs);
    if (ended || tooLong) void this.#finishUtterance();
  }

  #pushPreRoll(pcm: Float32Array): void {
    this.#preRoll.push(pcm);
    this.#preRollSamples += pcm.length;
    // preRollMs of silence before the speech, plus the chunks that detected the start.
    const cap = msToSamples(this.#o.preRollMs + this.#o.startMs);
    while (
      this.#preRoll.length > 1 &&
      this.#preRollSamples - (this.#preRoll[0]?.length ?? 0) >= cap
    ) {
      this.#preRollSamples -= this.#preRoll.shift()?.length ?? 0;
    }
  }

  #resetUtterance(): void {
    this.#inSpeech = false;
    this.#speech = [];
    this.#speechSamples = 0;
    this.#voicedSamples = 0;
    this.#silentSamples = 0;
    this.#pendingStart = 0;
    this.#preRoll = [];
    this.#preRollSamples = 0;
  }

  #resumeListening(): void {
    if (this.#state === 'cerrada') return;
    this.#resetUtterance();
    this.#idleSamples = 0;
    this.#skipSamples = msToSamples(this.#o.tailMs);
    this.#state = 'escuchando';
  }

  async #finishUtterance(): Promise<void> {
    const generation = this.#generation;
    const voiced = this.#voicedSamples;
    const total = this.#speechSamples;
    const joined = new Float32Array(total);
    let at = 0;
    for (const part of this.#speech) {
      joined.set(part, at);
      at += part.length;
    }
    this.#resetUtterance();
    if (voiced < msToSamples(this.#o.minVoicedMs)) return;

    this.#state = 'transcribiendo';
    let text: string;
    try {
      text = await this.#withTimeout(this.#transcriber(joined));
      this.#failures = 0;
    } catch (err) {
      if (generation !== this.#generation) return;
      this.#failures++;
      this.#lastError = err instanceof Error ? err.message : String(err);
      if (this.#failures >= this.#o.maxFailures) {
        this.close('fallo', `no consigo transcribir: ${this.#lastError}`);
        return;
      }
      this.#resumeListening();
      return;
    }
    // close() or /conversacion off during the transcription: the result is stale.
    if (generation !== this.#generation) return;
    await this.#handleText(text, generation);
  }

  /**
   * Run an utterance that did not come from the microphone stream (the request that
   * came with the wake word, "asistenta, ..."). Only while listening.
   */
  async submit(text: string): Promise<void> {
    if (this.#state !== 'escuchando') return;
    this.#resetUtterance();
    await this.#handleText(text, this.#generation);
  }

  async #handleText(raw: string, generation: number): Promise<void> {
    const text = raw.trim();
    this.#lastHeard = text;
    if (isNoise(text)) {
      this.#resumeListening();
      return;
    }
    if (isClosingPhrase(text)) {
      this.close('cierre');
      return;
    }

    this.#utterances++;
    this.#state = 'respondiendo';
    try {
      await this.#onUtterance(text);
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err);
    }
    if (generation !== this.#generation) return;
    this.#resumeListening();
  }

  #withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`la transcripción tardó más de ${this.#o.transcribeTimeoutMs / 1000}s`)),
        this.#o.transcribeTimeoutMs,
      );
      timer.unref?.();
    });
    return Promise.race([p, limit]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}
