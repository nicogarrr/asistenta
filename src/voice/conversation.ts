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
  /** Interrupt the agent while it talks. Default 'off': enabling it is explicit. */
  bargeIn?: BargeInLevel;
}

export type ConversationState =
  | 'escuchando'
  | 'transcribiendo'
  | 'respondiendo'
  | 'hablando'
  | 'cerrada';

/**
 * Barge-in mode. `off` keeps V1 behaviour: nothing is heard while the agent talks.
 * `altavoces` assumes the microphone hears the agent's own voice: the echo level is
 * measured from the first sound of each phrase (never from the silence before it) and
 * kept for the whole session. `auriculares` assumes no echo: any sustained speech over
 * the gate interrupts.
 */
export type BargeInLevel = 'off' | 'altavoces' | 'auriculares';

const BARGE_IN: Record<
  Exclude<BargeInLevel, 'off'>,
  { factor: number; sustainMs: number; calibrate: boolean }
> = {
  altavoces: { factor: 2, sustainMs: 400, calibrate: true },
  auriculares: { factor: 1, sustainMs: 300, calibrate: false },
};

/** Echo is measured over this much audio at the start of each phrase. */
const CALIBRATE_MS = 500;

export interface SpeakControl {
  /** Call when each phrase starts playing: the echo level is measured again. */
  phraseStart(): void;
  /** True once the user interrupted; the runner must stop producing sound. */
  interrupted(): boolean;
}

export type SpeakOutcome = 'fin' | 'interrumpido';

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
  #o: Required<Omit<ConversationOptions, 'transcriber' | 'onUtterance' | 'onClose' | 'bargeIn'>>;
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
  #bargeIn: BargeInLevel;
  #bargeIns = 0;
  /** Interrupciones cuya frase sembrada acabó en turno real (o cierre pedido). */
  #bargeTrue = 0;
  /** Interrupciones cuya frase sembrada era ruido descartado: falso disparo. */
  #bargeFalseNoise = 0;
  /** Interrupciones cuya frase sembrada era mi propia voz por los altavoces. */
  #bargeFalseEcho = 0;
  /** Which turn is allowed to resume listening when it ends (an interrupted one is not). */
  #turnSeq = 0;
  #speakStop: (() => void) | null = null;
  #speakInterrupted = false;
  #echoSum = 0;
  /** True once the first sound of this phrase was heard; silence never calibrates. */
  #echoStarted = false;
  /** Highest echo level measured in this session: a quieter phrase never lowers the bar. */
  #echoMax = 0;
  /** What was being read, to recognise the agent's own voice in an interrupting utterance. */
  #spokenWords = new Set<string>();
  #bargeSeeded = false;
  #echoLoops = 0;
  #echoSamples = 0;
  #loudSamples = 0;
  #speakBuf: Float32Array[] = [];
  #speakBufSamples = 0;
  /** True until the transcriber's own promise settles, even after our timeout gave up on it. */
  #transcribing = false;

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
    this.#bargeIn = opts.bargeIn ?? 'off';
    this.#transcriber = opts.transcriber;
    this.#onUtterance = opts.onUtterance;
    this.#onClose = opts.onClose;
  }

  state(): ConversationState {
    return this.#state;
  }

  stats(): {
    state: ConversationState;
    utterances: number;
    lastHeard: string;
    lastError: string;
    bargeIns: number;
    bargeTrue: number;
    bargeFalseNoise: number;
    bargeFalseEcho: number;
  } {
    return {
      bargeIns: this.#bargeIns,
      bargeTrue: this.#bargeTrue,
      bargeFalseNoise: this.#bargeFalseNoise,
      bargeFalseEcho: this.#bargeFalseEcho,
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
    if (this.#state === 'hablando') {
      this.#feedWhileSpeaking(pcm);
      return;
    }
    if (this.#state !== 'escuchando' || pcm.length === 0) return;
    if (this.#skipSamples > 0) {
      this.#skipSamples = Math.max(0, this.#skipSamples - pcm.length);
      return;
    }
    // Every listened sample counts, voiced or not: only a REAL turn resets the clock
    // (see #resumeListening), so a room that keeps making noise cannot hold the
    // microphone open by feeding whisper discarded transcripts.
    this.#idleSamples += pcm.length;
    if (this.#idleSamples >= msToSamples(this.#o.idleMs)) {
      this.close('inactividad');
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
        }
      } else {
        this.#pendingStart = 0;
        this.#pushPreRoll(pcm);
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

  /** `realTurn`: only an answered request resets the inactivity clock. */
  #resumeListening(realTurn = false): void {
    if (this.#state === 'cerrada') return;
    this.#resetUtterance();
    if (realTurn) this.#idleSamples = 0;
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

    // A previous transcription that outlived its timeout is still running: never two
    // whisper passes at once. This utterance is dropped.
    if (this.#transcribing) {
      this.#lastError = 'la transcripción anterior sigue en curso; descarto esta frase';
      return;
    }
    this.#state = 'transcribiendo';
    let text: string;
    try {
      this.#transcribing = true;
      const pending = this.#transcriber(joined);
      void pending.then(
        () => {
          this.#transcribing = false;
        },
        () => {
          this.#transcribing = false;
        },
      );
      text = await this.#withTimeout(pending);
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
    // Was this utterance seeded by a barge-in? That decides how it counts in the
    // false-trigger metric (item 11): noise or self-echo after interrupting is a
    // false trigger; a real turn (or a spoken close) is a true one.
    const seeded = this.#bargeSeeded;
    this.#bargeSeeded = false;
    if (isNoise(text)) {
      if (seeded) this.#bargeFalseNoise++;
      this.#resumeListening();
      return;
    }
    // The utterance that interrupted the agent may be the agent itself, heard through
    // the speakers. Mostly the same words as what it was reading: not a request.
    if (seeded && this.#isSelfEcho(text)) {
      this.#bargeFalseEcho++;
      this.#echoLoops++;
      this.#lastError = 'me he oído a mí mismo; descarto esa frase';
      // Twice in a row: the speakers feed the microphone. Stop interrupting.
      if (this.#echoLoops >= 2) {
        this.#bargeIn = 'off';
        this.#lastError =
          'me oigo a mí mismo por los altavoces; dejo de dejarme interrumpir en esta sesión';
      }
      this.#resumeListening();
      return;
    }
    if (seeded) {
      this.#echoLoops = 0;
      this.#bargeTrue++;
    }
    if (isClosingPhrase(text)) {
      this.close('cierre');
      return;
    }

    this.#utterances++;
    this.#state = 'respondiendo';
    const mine = ++this.#turnSeq;
    try {
      await this.#onUtterance(text);
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err);
    }
    if (generation !== this.#generation) return;
    // Interrupted (barge-in) or superseded by a newer turn: that one owns the state now.
    if (mine !== this.#turnSeq || this.#state !== 'respondiendo') return;
    this.#resumeListening(true);
  }

  /**
   * Speak out loud (the greeting or a turn's answer). While it plays the session is
   * 'hablando': the agent's own voice is never taken for a request, and, with barge-in
   * on, the user talking over it stops the sound (`stop`) and what they say becomes the
   * next utterance. Called while listening (greeting) it resumes listening with the echo
   * tail dropped; called from inside a turn the turn itself resumes afterwards.
   * Resolves once `run` has settled.
   */
  async speak(
    run: (ctl: SpeakControl) => Promise<void>,
    opts: { stop?: () => void; text?: string } = {},
  ): Promise<SpeakOutcome> {
    const fromListening = this.#state === 'escuchando';
    if (!fromListening && this.#state !== 'respondiendo') return 'fin';
    const generation = this.#generation;
    if (fromListening) this.#resetUtterance();
    const returnTo: ConversationState = fromListening ? 'escuchando' : 'respondiendo';
    const turn = this.#turnSeq;
    this.#state = 'hablando';
    this.#speakStop = opts.stop ?? null;
    this.#spokenWords = new Set(
      normaliseSpeech(opts.text ?? '')
        .split(' ')
        .filter(Boolean),
    );
    this.#speakInterrupted = false;
    this.#restartCalibration();
    this.#speakBuf = [];
    this.#speakBufSamples = 0;
    const ctl: SpeakControl = {
      phraseStart: () => this.#restartCalibration(),
      interrupted: () => this.#speakInterrupted,
    };
    try {
      await run(ctl);
    } catch (err) {
      this.#lastError = err instanceof Error ? err.message : String(err);
    }
    const interrupted = this.#speakInterrupted;
    this.#speakStop = null;
    this.#speakInterrupted = false;
    if (generation !== this.#generation) return interrupted ? 'interrumpido' : 'fin';
    if (interrupted) return 'interrumpido'; // the session already went back to listening
    if (this.#state === 'hablando' && turn === this.#turnSeq) {
      this.#state = returnTo;
      if (fromListening) this.#resumeListening();
    }
    return 'fin';
  }

  #isSelfEcho(text: string): boolean {
    if (this.#spokenWords.size === 0) return false;
    const words = normaliseSpeech(text).split(' ').filter(Boolean);
    if (words.length < 3) return false;
    const inside = words.filter((w) => this.#spokenWords.has(w)).length;
    return inside / words.length >= 0.8;
  }

  #restartCalibration(): void {
    this.#echoSum = 0;
    this.#echoSamples = 0;
    this.#loudSamples = 0;
    this.#echoStarted = false;
  }

  #feedWhileSpeaking(pcm: Float32Array): void {
    if (this.#bargeIn === 'off' || !this.#speakStop || pcm.length === 0) return;
    const level = BARGE_IN[this.#bargeIn];
    const level_rms = rms(pcm);
    // Keep a short tail of what was heard: it seeds the interrupting utterance.
    this.#speakBuf.push(pcm);
    this.#speakBufSamples += pcm.length;
    const keep = msToSamples(this.#o.preRollMs + level.sustainMs) + pcm.length;
    while (
      this.#speakBuf.length > 1 &&
      this.#speakBufSamples - (this.#speakBuf[0]?.length ?? 0) >= keep
    ) {
      this.#speakBufSamples -= this.#speakBuf.shift()?.length ?? 0;
    }
    // altavoces: the room's echo of our own voice is measured over CALIBRATE_MS from the
    // first SOUND of the phrase. Never from the moment playback was requested: the player
    // takes hundreds of ms to start, and that window is silence (measuring it made the
    // agent cut itself off and answer itself). Declared: a user already talking when the
    // phrase starts is measured as echo for that phrase.
    let echo = 0;
    if (level.calibrate) {
      if (!this.#echoStarted) {
        if (level_rms < this.#o.gateRms) return;
        this.#echoStarted = true;
      }
      if (this.#echoSamples < msToSamples(CALIBRATE_MS)) {
        this.#echoSum += level_rms * pcm.length;
        this.#echoSamples += pcm.length;
        this.#echoMax = Math.max(this.#echoMax, this.#echoSum / this.#echoSamples);
        return;
      }
      echo = Math.max(this.#echoMax, this.#echoSum / Math.max(1, this.#echoSamples));
    }
    const threshold = Math.max(this.#o.gateRms, level.factor * echo);
    if (level_rms >= threshold) this.#loudSamples += pcm.length;
    else this.#loudSamples = 0;
    if (this.#loudSamples < msToSamples(level.sustainMs)) return;

    // Interruption: stop the sound NOW and make what was heard the start of an utterance.
    this.#speakInterrupted = true;
    this.#bargeIns++;
    this.#turnSeq++;
    const stop = this.#speakStop;
    this.#speakStop = null;
    this.#resetUtterance();
    this.#speech = [...this.#speakBuf];
    this.#speechSamples = this.#speakBufSamples;
    this.#voicedSamples = this.#loudSamples;
    this.#silentSamples = 0;
    this.#inSpeech = true;
    this.#bargeSeeded = true;
    this.#speakBuf = [];
    this.#speakBufSamples = 0;
    this.#idleSamples = 0;
    this.#skipSamples = 0;
    this.#state = 'escuchando';
    try {
      stop?.();
    } catch {
      // The sound is already being cut by the caller's own abort; never throw into the audio path.
    }
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
