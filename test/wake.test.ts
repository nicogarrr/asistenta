import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  matchesWakeWord,
  normaliseForMatch,
  type WakeCapture,
  WakeWordListener,
} from '../src/voice/wake.js';

/**
 * No microphone and no whisper model here by design: the capture source and the
 * transcriber are injection points precisely so this suite can assert the wake
 * logic (energy gate, suppression, matching, shutdown) in milliseconds instead
 * of spawning ffmpeg against the real device. The real device path was verified
 * separately with a one-off script against the bundled ffmpeg and the cached
 * checkpoint.
 */

/** Speech-like energy: RMS of a 0.2 sine is ~0.14, well above the 0.05 gate. */
function tone(amplitude: number, seconds = 0.5): Float32Array {
  const length = Math.round(seconds * 16_000);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.sin((i * 2 * Math.PI * 220) / 16_000) * amplitude;
  return out;
}

function silence(seconds = 0.5): Float32Array {
  return new Float32Array(Math.round(seconds * 16_000));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await wait(20);
  }
}

/**
 * Stand-in for the ffmpeg capture. Optionally writes a heartbeat file per tick
 * while started, which is what lets the stop() test observe "the capture is
 * genuinely dead" instead of trusting a call counter.
 */
class FakeCapture implements WakeCapture {
  onChunk: ((pcm: Float32Array) => void) | null = null;
  startCalls = 0;
  stopCalls = 0;
  startError: Error | null = null;
  heartbeatDir: string | null = null;
  #onError: ((err: Error) => void) | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;

  async start(onChunk: (pcm: Float32Array) => void, onError: (err: Error) => void): Promise<void> {
    this.startCalls++;
    if (this.startError) throw this.startError;
    this.onChunk = onChunk;
    this.#onError = onError;
    const dir = this.heartbeatDir;
    if (dir) {
      this.#heartbeat = setInterval(() => {
        writeFileSync(join(dir, `hb-${Date.now()}-${this.startCalls}-${Math.random()}.txt`), 'x');
      }, 25);
      this.#heartbeat.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.stopCalls++;
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }

  /** Deliver audio. Keeps working after stop() on purpose: stragglers must be ignored. */
  push(pcm: Float32Array): void {
    this.onChunk?.(pcm);
  }

  fail(err: Error): void {
    this.#onError?.(err);
  }
}

describe('normaliseForMatch', () => {
  it('strips accents so an unaccented transcription still matches', () => {
    // Whisper returns accents inconsistently on bad audio; both sides get folded.
    expect(normaliseForMatch('niño')).toBe('nino');
    expect(normaliseForMatch('acción')).toBe('accion');
    expect(normaliseForMatch('ORDENADÓR')).toBe('ordenador');
  });

  it('strips punctuation and collapses whitespace, including whisper leading spaces', () => {
    expect(normaliseForMatch('  ¿Cómo estás, niño? ')).toBe('como estas nino');
    expect(normaliseForMatch(' ordenador')).toBe('ordenador');
    expect(normaliseForMatch('El ordenador.')).toBe('el ordenador');
    expect(normaliseForMatch('ordenador...')).toBe('ordenador');
  });

  it('is total on empty and symbol-only input', () => {
    expect(normaliseForMatch('')).toBe('');
    expect(normaliseForMatch('   ')).toBe('');
    expect(normaliseForMatch('¿¡?!')).toBe('');
  });
});

describe('matchesWakeWord', () => {
  it('matches the exact word and its sentence forms', () => {
    expect(matchesWakeWord('ordenador', 'ordenador')).toBe(true);
    expect(matchesWakeWord(' Ordenador', 'ordenador')).toBe(true);
    expect(matchesWakeWord('El ordenador', 'ordenador')).toBe(true);
    expect(matchesWakeWord('Necesito el ordenador.', 'ordenador')).toBe(true);
    expect(matchesWakeWord('el ordenador, por favor', 'ordenador')).toBe(true);
  });

  it('matches through accents and punctuation on both sides', () => {
    expect(matchesWakeWord('¿¡ORDENADOR!?', 'ordenador')).toBe(true);
    expect(matchesWakeWord('accion total', 'acción')).toBe(true);
    expect(matchesWakeWord('un ano', 'año')).toBe(true);
  });

  it('never matches the word inside a longer word', () => {
    // "Coordenador del proyecto." is what whisper actually returned for that
    // sentence; substring matching would wake on it every time.
    expect(matchesWakeWord('coordenador del proyecto', 'ordenador')).toBe(false);
    expect(matchesWakeWord('preordenador', 'ordenador')).toBe(false);
    expect(matchesWakeWord('ordenadores', 'ordenador')).toBe(false);
    expect(matchesWakeWord('ordenadora', 'ordenador')).toBe(false);
    // Not even at the loosest sensitivity: no tier admits a longer token.
    expect(matchesWakeWord('coordenador', 'ordenador', 0.1)).toBe(false);
  });

  it('returns false on empty input on either side', () => {
    expect(matchesWakeWord('', 'ordenador')).toBe(false);
    expect(matchesWakeWord('   ', 'ordenador')).toBe(false);
    expect(matchesWakeWord('ordenador', '')).toBe(false);
    expect(matchesWakeWord('ordenador', '  ')).toBe(false);
  });

  it('tightens to the exact phrase at sensitivity 1.0', () => {
    // Whisper's short-clip truncation ("ordenad") is real output, but at 1.0 the
    // caller asked for the exact phrase only.
    expect(matchesWakeWord('ordenador', 'ordenador', 1)).toBe(true);
    expect(matchesWakeWord('ordenad', 'ordenador', 1)).toBe(false);
    expect(matchesWakeWord('El ordenador', 'ordenador', 1)).toBe(true);
  });

  it('admits whisper truncations at the default sensitivity', () => {
    expect(matchesWakeWord('ordenad', 'ordenador')).toBe(true);
    expect(matchesWakeWord('ordenad', 'ordenador', 0.85)).toBe(true);
    // The truncation budget is exactly two characters: a shorter cut ("ordena")
    // is a different Spanish word, and a one-character cut ("ordenado") is too —
    // that one lives in the near tier below.
    expect(matchesWakeWord('ordena', 'ordenador')).toBe(false);
    expect(matchesWakeWord('ordena', 'ordenador', 0.1)).toBe(false);
    expect(matchesWakeWord('orden', 'ordenador', 0.1)).toBe(false);
  });

  it('admits one-edit near-misses only below sensitivity 0.85', () => {
    // "ordenado" is a real word ("he ordenado la mesa"); the false-positive
    // bias keeps it out of the default tier even one edit from the wake word.
    expect(matchesWakeWord('ordenado', 'ordenador')).toBe(false);
    expect(matchesWakeWord('ordenado', 'ordenador', 0.7)).toBe(true);
    expect(matchesWakeWord('ordinador', 'ordenador', 0.7)).toBe(true);
    // Two edits ("ordenar" drops "do") stays out even at the loosest tier.
    expect(matchesWakeWord('ordenar', 'ordenador', 0.7)).toBe(false);
    expect(matchesWakeWord('ordenar', 'ordenador', 0.1)).toBe(false);
  });

  it('clamps sensitivity instead of misbehaving outside 0..1', () => {
    expect(matchesWakeWord('ordenador', 'ordenador', 5)).toBe(true);
    expect(matchesWakeWord('ordenad', 'ordenador', -3)).toBe(true);
    expect(matchesWakeWord('ordenad', 'ordenador', Number.NaN)).toBe(false);
  });

  it('treats a multi-word wake phrase as consecutive tokens', () => {
    expect(matchesWakeWord('el ordenador', 'el ordenador')).toBe(true);
    expect(matchesWakeWord('necesito el ordenador', 'el ordenador')).toBe(true);
    expect(matchesWakeWord('el un ordenador', 'el ordenador')).toBe(false);
    expect(matchesWakeWord('ordenador', 'el ordenador')).toBe(false);
    expect(matchesWakeWord('el ordenad', 'el ordenador', 0.85)).toBe(true);
  });
});

describe('WakeWordListener energy gate', () => {
  it('never transcribes a silent window', async () => {
    // The whole point of stage 1: silence must not cost an inference, and the
    // fake transcriber here stands in for a whisper pass we can count.
    const transcriber = vi.fn(async () => 'ordenador');
    const capture = new FakeCapture();
    const listener = new WakeWordListener({ capture, transcriber, checkIntervalMs: 100 });
    await listener.start();
    capture.push(silence(1));
    await wait(350);
    expect(transcriber).not.toHaveBeenCalled();
    expect(listener.stats()).toEqual({ checks: 0, wakeCount: 0, lastWakeAt: null, suppressed: 0 });
    await listener.stop();
  });

  it('never transcribes noise below the RMS gate', async () => {
    // A 0.05-amplitude sine is RMS ~0.035: above digital silence, below the
    // 0.05 gate that sits above the measured room-noise floor.
    const transcriber = vi.fn(async () => 'ordenador');
    const capture = new FakeCapture();
    const listener = new WakeWordListener({ capture, transcriber, checkIntervalMs: 100 });
    await listener.start();
    capture.push(tone(0.05, 0.5));
    await wait(350);
    expect(transcriber).not.toHaveBeenCalled();
    await listener.stop();
  });

  it('transcribes speech-like energy but only wakes on the word', async () => {
    const transcriber = vi.fn(async () => 'hola buenos dias');
    const wakes: string[] = [];
    const capture = new FakeCapture();
    const listener = new WakeWordListener({
      capture,
      transcriber,
      checkIntervalMs: 100,
      onWake: (heard) => {
        wakes.push(heard);
      },
    });
    await listener.start();
    capture.push(tone(0.2, 0.5));
    await waitFor(() => listener.stats().checks >= 1, 1_000);
    expect(transcriber).toHaveBeenCalled();
    expect(wakes).toEqual([]);
    expect(listener.stats().wakeCount).toBe(0);
    await listener.stop();
  });
});

describe('WakeWordListener wake handling', () => {
  it('wakes once per utterance and hands the transcript to onWake', async () => {
    const transcriber = vi.fn(async () => ' La asistenta');
    const wakes: string[] = [];
    const capture = new FakeCapture();
    const listener = new WakeWordListener({
      capture,
      transcriber,
      checkIntervalMs: 100,
      onWake: (heard) => {
        wakes.push(heard);
      },
    });
    await listener.start();
    capture.push(tone(0.2, 0.5));
    await waitFor(() => listener.stats().wakeCount === 1, 1_000);
    expect(wakes).toEqual([' La asistenta']);
    expect(listener.stats().lastWakeAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The window is cleared on wake, so the same utterance cannot fire again:
    // without that, one "ordenador" would launch a task per check interval.
    await wait(350);
    expect(transcriber).toHaveBeenCalledTimes(1);
    expect(listener.stats().wakeCount).toBe(1);
    await listener.stop();
  });

  it('routes a throwing onWake to onError and keeps listening', async () => {
    const errors: Error[] = [];
    const capture = new FakeCapture();
    const listener = new WakeWordListener({
      capture,
      transcriber: async () => 'asistenta',
      checkIntervalMs: 100,
      onWake: () => {
        throw new Error('el handler fallo');
      },
      onError: (err) => {
        errors.push(err);
      },
    });
    await listener.start();
    capture.push(tone(0.2, 0.5));
    await waitFor(() => errors.length >= 1, 1_000);
    expect(errors[0]?.message).toBe('el handler fallo');
    expect(listener.isRunning()).toBe(true);
    await listener.stop();
  });
});

describe('WakeWordListener suppression', () => {
  it('drops playback audio from the window and skips checks while suppressed', async () => {
    const windows: Float32Array[] = [];
    const transcriber = vi.fn(async (samples: Float32Array) => {
      windows.push(samples);
      return 'asistenta';
    });
    const capture = new FakeCapture();
    const listener = new WakeWordListener({ capture, transcriber, checkIntervalMs: 100 });
    await listener.start();

    // The agent's own tts, played out loud into the same microphone: 0.9 peak.
    listener.suppress(300);
    capture.push(tone(0.9, 0.4));
    await wait(150);
    expect(transcriber).not.toHaveBeenCalled();
    expect(listener.stats().suppressed).toBeGreaterThanOrEqual(1);

    await wait(250);
    capture.push(tone(0.2, 0.5));
    await waitFor(() => listener.stats().wakeCount === 1, 1_000);

    expect(transcriber).toHaveBeenCalledTimes(1);
    expect(windows.length).toBe(1);
    let peak = 0;
    for (const sample of windows[0] ?? []) peak = Math.max(peak, Math.abs(sample));
    // The tts tone never entered the window: without suppress() this is the loop
    // where the agent transcribes itself and wakes on its own answer.
    expect(peak).toBeLessThan(0.5);
    await listener.stop();
  });

  it('extends rather than shortens when called again', async () => {
    const transcriber = vi.fn(async () => 'ordenador');
    const capture = new FakeCapture();
    const listener = new WakeWordListener({ capture, transcriber, checkIntervalMs: 100 });
    await listener.start();
    listener.suppress(400);
    listener.suppress(10);
    capture.push(tone(0.2, 0.5)); // playback audio: dropped while suppressed
    // The short second call must not cut the cover to 10ms: the 100/200/300ms
    // checks are all inside the 400ms window the first call set. Discriminating
    // through the dropped audio alone is impossible (it never enters the window
    // either way), so the covered check count is what proves the extension.
    await waitFor(() => listener.stats().suppressed >= 3, 1_000);
    expect(transcriber).not.toHaveBeenCalled();
    await listener.stop();
  });
});

describe('WakeWordListener shutdown', () => {
  it('stop() twice does not throw and releases the capture exactly once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pa-wake-'));
    try {
      const capture = new FakeCapture();
      capture.heartbeatDir = dir;
      const transcriber = vi.fn(async () => 'ordenador');
      const listener = new WakeWordListener({ capture, transcriber, checkIntervalMs: 100 });
      await listener.start();
      capture.push(tone(0.2, 0.3));
      await waitFor(() => transcriber.mock.calls.length >= 1, 1_000);

      await listener.stop();
      await expect(listener.stop()).resolves.toBeUndefined();
      expect(capture.stopCalls).toBe(1);
      expect(listener.isRunning()).toBe(false);

      const heartbeats = readdirSync(dir).length;
      // Stragglers after stop must be ignored: a leaked capture feeding a live
      // ring buffer is how a "stopped" listener keeps waking the agent.
      capture.push(tone(0.2, 0.3));
      await wait(250);
      expect(readdirSync(dir).length).toBe(heartbeats);
      expect(transcriber).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is safe to stop before start', async () => {
    const capture = new FakeCapture();
    const listener = new WakeWordListener({ capture, transcriber: async () => '' });
    await expect(listener.stop()).resolves.toBeUndefined();
    expect(capture.stopCalls).toBe(0);
    expect(listener.isRunning()).toBe(false);
  });
});

describe('WakeWordListener failure paths', () => {
  it('surfaces a busy microphone once, in Spanish, without retrying', async () => {
    const capture = new FakeCapture();
    capture.startError = new Error(
      'el microfono "Varios micrófonos" esta ocupado por otro programa; no hago reintentos automaticos',
    );
    const listener = new WakeWordListener({ capture, transcriber: async () => '' });
    await expect(listener.start()).rejects.toThrow(/ocupado por otro programa/);
    expect(capture.startCalls).toBe(1);
    expect(listener.isRunning()).toBe(false);
    await expect(listener.start()).rejects.toThrow(/ocupado/);
    expect(capture.startCalls).toBe(2);
    await listener.stop();
  });

  it('stops on a capture error instead of hot-looping a restart', async () => {
    const errors: Error[] = [];
    const capture = new FakeCapture();
    const listener = new WakeWordListener({
      capture,
      transcriber: async () => '',
      onError: (err) => {
        errors.push(err);
      },
    });
    await listener.start();
    capture.fail(new Error('la captura de audio se detuvo'));
    await waitFor(() => !listener.isRunning(), 1_000);
    expect(errors.map((err) => err.message)).toContain('la captura de audio se detuvo');
    expect(capture.startCalls).toBe(1);
    await listener.stop();
  });

  it('reports transcriber failures and stops after three in a row', async () => {
    const errors: Error[] = [];
    const transcriber = vi.fn(async () => {
      throw new Error('whisper se cayo');
    });
    const capture = new FakeCapture();
    const listener = new WakeWordListener({
      capture,
      transcriber,
      checkIntervalMs: 100,
      onError: (err) => {
        errors.push(err);
      },
    });
    await listener.start();
    capture.push(tone(0.2, 0.5));
    await waitFor(() => !listener.isRunning(), 2_000);
    // Capped, not an every-interval retry against a broken model.
    expect(transcriber).toHaveBeenCalledTimes(3);
    expect(errors.some((err) => /3 fallos/.test(err.message))).toBe(true);
    await listener.stop();
  });
});

describe('WakeWordListener lifecycle', () => {
  it('start() twice captures once and isRunning tracks the lifecycle', async () => {
    const capture = new FakeCapture();
    const listener = new WakeWordListener({ capture, transcriber: async () => '' });
    expect(listener.isRunning()).toBe(false);
    await listener.start();
    await listener.start();
    expect(capture.startCalls).toBe(1);
    expect(listener.isRunning()).toBe(true);
    await listener.stop();
    expect(listener.isRunning()).toBe(false);
  });

  it('refuses an empty wake word before touching the capture', async () => {
    const capture = new FakeCapture();
    const listener = new WakeWordListener({ capture, word: '!!!', transcriber: async () => '' });
    await expect(listener.start()).rejects.toThrow(/vacia/);
    expect(capture.startCalls).toBe(0);
    expect(listener.isRunning()).toBe(false);
  });
});
