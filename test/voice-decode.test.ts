import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { describe, expect, it } from 'vitest';
import { encodeMp3, pcmToWavPcm16 } from '../src/voice/audio.js';
import {
  DECODE_SAMPLE_RATE,
  decodeAudioWithFfmpeg,
  decodeForWhisper,
  ffmpegDecoderAvailable,
} from '../src/voice/decode.js';

/**
 * Two tiers, mirroring how the repo treats ffmpeg everywhere else (wake.test.ts):
 * input validation runs everywhere; the real decodes run only where the bundled
 * binary exists. CI installs with --ignore-scripts, so the binary is absent there
 * and those cases skip; a real `npm ci` (README, Dockerfile, Nico's PC) runs the
 * postinstall and exercises the actual decode path a Telegram mp3/m4a/wav takes.
 * Whisper itself stays out of scope (the model download stays out of tests).
 */

const FFMPEG = ffmpegDecoderAvailable();
const FFMPEG_BIN: string | null =
  typeof ffmpegStatic === 'string'
    ? ffmpegStatic
    : ((ffmpegStatic as { default?: string }).default ?? null);

/** 1s of a 440Hz tone: non-silent, non-degenerate, and survives mp3 at 32kbps. */
function tone(seconds: number, rate: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
  return out;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

/** A real AAC-in-m4a with the moov atom at the end (ffmpeg's default layout). */
function makeM4a(seconds: number): Buffer {
  if (!FFMPEG_BIN) throw new Error('no ffmpeg');
  const dir = mkdtempSync(join(tmpdir(), 'pa-test-m4a-'));
  try {
    const wav = join(dir, 'in.wav');
    const m4a = join(dir, 'out.m4a');
    writeFileSync(wav, pcmToWavPcm16(tone(seconds, 16_000), 16_000));
    const res = spawnSync(FFMPEG_BIN, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      wav,
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      m4a,
    ]);
    if (res.status !== 0) throw new Error(`fixture m4a failed: ${res.stderr}`);
    return readFileSync(m4a);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const paDecodeDirs = (): string[] =>
  readdirSync(tmpdir()).filter((d) => d.startsWith('pa-decode-'));

describe('decodeAudioWithFfmpeg', () => {
  it('rejects an empty buffer before spawning ffmpeg', async () => {
    await expect(decodeAudioWithFfmpeg(Buffer.alloc(0))).rejects.toThrow(/vacio/);
  });

  it('rejects input over the byte cap', async () => {
    const big = Buffer.alloc(25_000_001);
    await expect(decodeAudioWithFfmpeg(big)).rejects.toThrow(/maximo/);
  });

  it.runIf(FFMPEG)(
    'decodes a wav to mono 16kHz float pcm',
    async () => {
      // 22.05kHz source: the resample to 16k is exercised, not bypassed.
      const wav = pcmToWavPcm16(tone(1, 22_050), 22_050);
      const out = await decodeAudioWithFfmpeg(wav);
      expect(out.sampleRate).toBe(DECODE_SAMPLE_RATE);
      expect(out.capped).toBe(false);
      // Duration survives within a frame of tolerance.
      expect(Math.abs(out.samples.length - DECODE_SAMPLE_RATE)).toBeLessThan(2048);
      // And it is the tone, not silence or noise: RMS of a 0.5 sine is ~0.35.
      expect(rms(out.samples)).toBeGreaterThan(0.2);
      expect(rms(out.samples)).toBeLessThan(0.6);
    },
    20_000,
  );

  it.runIf(FFMPEG)(
    'decodes an mp3 (the mime Telegram reports for audio uploads)',
    async () => {
      const mp3 = encodeMp3(tone(1, 16_000), 16_000, 32);
      const out = await decodeAudioWithFfmpeg(mp3);
      expect(out.sampleRate).toBe(DECODE_SAMPLE_RATE);
      expect(out.capped).toBe(false);
      // mp3 pads the stream with encoder delay; a wide window beats a brittle equality.
      expect(out.samples.length).toBeGreaterThan(DECODE_SAMPLE_RATE * 0.8);
      expect(out.samples.length).toBeLessThan(DECODE_SAMPLE_RATE * 1.4);
      expect(rms(out.samples)).toBeGreaterThan(0.15);
    },
    20_000,
  );

  it.runIf(FFMPEG)(
    'decodes a 120s AAC m4a with moov at the end (auditor canary: pipe input could not seek)',
    async () => {
      const m4a = makeM4a(120);
      const out = await decodeAudioWithFfmpeg(m4a);
      expect(out.sampleRate).toBe(DECODE_SAMPLE_RATE);
      expect(out.capped).toBe(false);
      // 120s at 16kHz, with AAC frame tolerance.
      expect(out.samples.length).toBeGreaterThan(119 * DECODE_SAMPLE_RATE);
      expect(out.samples.length).toBeLessThan(122 * DECODE_SAMPLE_RATE);
      expect(rms(out.samples)).toBeGreaterThan(0.15);
    },
    30_000,
  );

  it.runIf(FFMPEG)(
    'rejects bytes that are not audio with an honest Spanish message',
    async () => {
      await expect(decodeAudioWithFfmpeg(Buffer.from('ID3 not really audio'))).rejects.toThrow(
        /no pude leer ese audio/,
      );
    },
    20_000,
  );

  it.runIf(FFMPEG)(
    'caps decoding at maxSeconds and says so (capped)',
    async () => {
      // 3s of tone with a 1s cap: the transcript of a long audio must never be
      // presented as complete.
      const wav = pcmToWavPcm16(tone(3, 16_000), 16_000);
      const out = await decodeAudioWithFfmpeg(wav, { maxSeconds: 1 });
      expect(out.capped).toBe(true);
      expect(out.samples.length).toBeLessThanOrEqual((1 + 1) * DECODE_SAMPLE_RATE);
      expect(out.samples.length).toBeGreaterThan(DECODE_SAMPLE_RATE * 0.9);
    },
    20_000,
  );

  it.runIf(FFMPEG)(
    'does not mark audio under the cap as capped',
    async () => {
      const wav = pcmToWavPcm16(tone(1, 16_000), 16_000);
      const out = await decodeAudioWithFfmpeg(wav, { maxSeconds: 5 });
      expect(out.capped).toBe(false);
    },
    20_000,
  );

  it.runIf(FFMPEG)(
    'a real timeout kills ffmpeg and reports it',
    async () => {
      // 1ms: no real decode (spawn included) can finish, so the timeout path,
      // the SIGKILL and the message are exercised for real.
      const wav = pcmToWavPcm16(tone(1, 16_000), 16_000);
      await expect(decodeAudioWithFfmpeg(wav, { timeoutMs: 1 })).rejects.toThrow(
        /tardo mas de 1ms/,
      );
    },
    20_000,
  );

  it.runIf(FFMPEG)(
    'the private temp input is removed on success and on failure',
    async () => {
      const before = paDecodeDirs();
      const wav = pcmToWavPcm16(tone(1, 16_000), 16_000);
      await decodeAudioWithFfmpeg(wav);
      await expect(decodeAudioWithFfmpeg(Buffer.from('not audio'))).rejects.toThrow();
      await expect(decodeAudioWithFfmpeg(wav, { timeoutMs: 1 })).rejects.toThrow();
      expect(paDecodeDirs()).toEqual(before);
    },
    30_000,
  );

  it('reports whether the bundled binary resolved (skips the real decodes in CI)', () => {
    // CI has no binary by design (--ignore-scripts); a real install does. This
    // only pins the probe's shape so the skip above is a decision, not a bug.
    expect(typeof FFMPEG).toBe('boolean');
  });
});

describe('decodeForWhisper (mime routing)', () => {
  it.runIf(FFMPEG)(
    'a wrong mime does not refuse: wav bytes labelled ogg decode via ffmpeg',
    async () => {
      const wav = pcmToWavPcm16(tone(1, 16_000), 16_000);
      const out = await decodeForWhisper(wav, 'audio/ogg');
      expect(out.sampleRate).toBe(DECODE_SAMPLE_RATE);
      expect(rms(out.samples)).toBeGreaterThan(0.2);
    },
    20_000,
  );

  it.runIf(FFMPEG)(
    'a missing mime falls back the same way',
    async () => {
      const wav = pcmToWavPcm16(tone(1, 16_000), 16_000);
      const out = await decodeForWhisper(wav);
      expect(rms(out.samples)).toBeGreaterThan(0.2);
    },
    20_000,
  );

  it.runIf(FFMPEG)(
    'garbage labelled ogg fails honestly after both decoders',
    async () => {
      await expect(
        decodeForWhisper(Buffer.from('neither ogg nor audio'), 'audio/ogg'),
      ).rejects.toThrow(/no pude leer ese audio/);
    },
    20_000,
  );
});
