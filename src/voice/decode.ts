/**
 * Decode any audio container to whisper-ready PCM with the bundled ffmpeg.
 *
 * Telegram voice notes arrive as ogg/opus and decode in-process (audio.ts), but an
 * audio uploaded as a file is an mp3, m4a, wav or aac, and there is no decoder for
 * those in this process. Silently feeding those bytes to the opus decoder produces a
 * fluent, invented transcript - worse than no answer - so until now the turn was
 * rejected with "solo se transcriben notas ogg/opus". ffmpeg-static is already a
 * dependency (screen recorder), is offline and costs nothing, and sniffs the real
 * format from the bytes, so the mime type only decides which decoder runs first,
 * never the result.
 *
 * Input goes through a private temp file, not a pipe: an AAC in m4a with the moov
 * atom at the end (ffmpeg's default layout) needs a seekable input, and from a pipe
 * a file larger than the probe buffer fails to open at all. The temp file is 0600
 * inside a private 0700 dir and is removed on success, error and timeout alike.
 *
 * The ceilings live here, not at the caller: a downloaded audio can be a two-hour
 * mixtape, and whisper at roughly real-time speed would turn that into a hung turn.
 * Decoding stops at `maxSeconds` and the caller is told it happened (`capped`), so a
 * truncated transcript is never presented as complete. These caps apply ONLY to
 * this ffmpeg path: the ogg/opus voice-note path keeps its own, unchanged limits.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import type { DecodedPcm } from './audio.js';
import { decodeOggOpusToPcm } from './audio.js';

/** Same narrowing as screen/recorder.ts: typed as a module, a string at runtime. */
const FFMPEG: string | null =
  typeof ffmpegStatic === 'string'
    ? ffmpegStatic
    : ((ffmpegStatic as { default?: string }).default ?? null);

export const DECODE_SAMPLE_RATE = 16_000;
/** Longest audio whisper is asked to read. 15 min ≈ 4x the measured per-note budget. */
export const DEFAULT_MAX_SECONDS = 15 * 60;
/** Wall clock for the decode itself; ffmpeg demuxes far faster than real time. */
const DECODE_TIMEOUT_MS = 60_000;
/** Telegram's bot download cap is 20MB; anything bigger here is a bug or an attack. */
const MAX_INPUT_BYTES = 25_000_000;

export interface FfmpegDecoded extends DecodedPcm {
  /** True when the audio hit `maxSeconds` and the rest was never decoded. */
  capped: boolean;
}

export function ffmpegDecoderAvailable(): boolean {
  return FFMPEG !== null && existsSync(FFMPEG);
}

/**
 * Pick the decoder by reported mime, with content sniffing as the net: a wrong or
 * missing mime (an mp3 labelled ogg) falls to ffmpeg once the opus decoder has
 * already failed, and only ffmpeg's own failure is reported as unreadable. What
 * never happens is presenting invented output as a transcript.
 */
export async function decodeForWhisper(input: Buffer, mimeType?: string): Promise<FfmpegDecoded> {
  const mime = mimeType?.toLowerCase() ?? '';
  if (mime && !mime.includes('ogg') && !mime.includes('opus')) {
    return await decodeAudioWithFfmpeg(input);
  }
  try {
    return { ...(await decodeOggOpusToPcm(input)), capped: false };
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('no opus frames')) throw err;
    return await decodeAudioWithFfmpeg(input);
  }
}

/**
 * Decode `input` (any container ffmpeg sniffs: mp3, m4a, wav, aac, webm, mp4 audio)
 * to mono 16 kHz float PCM. Rejects with an honest Spanish message: the bytes were
 * not audio, the process overran, or the binary is missing.
 */
export async function decodeAudioWithFfmpeg(
  input: Buffer,
  opts: { maxSeconds?: number; timeoutMs?: number } = {},
): Promise<FfmpegDecoded> {
  // Input validation precedes the availability check: a bad input is the same
  // answer on every machine, including one where the binary failed to install.
  if (input.length === 0) throw new Error('el audio llego vacio');
  if (input.length > MAX_INPUT_BYTES) {
    throw new Error(`el audio pesa ${Math.round(input.length / 1_000_000)}MB; el maximo son 25MB`);
  }
  if (!ffmpegDecoderAvailable() || !FFMPEG) {
    throw new Error('ffmpeg no esta disponible (falta ffmpeg-static)');
  }
  const maxSeconds = Math.max(1, Math.trunc(opts.maxSeconds ?? DEFAULT_MAX_SECONDS));
  const timeoutMs = Math.max(1, Math.trunc(opts.timeoutMs ?? DECODE_TIMEOUT_MS));
  // One second of slack over the cap, so `capped` is decided on duration, not on a
  // race between the cap and the stream end.
  const maxOutBytes = (maxSeconds + 1) * DECODE_SAMPLE_RATE * 4;

  // Seekable input, private from creation to removal. No extension on purpose:
  // ffmpeg sniffs the container from the bytes, and a guessed one would only
  // mislead the log.
  const dir = mkdtempSync(join(tmpdir(), 'pa-decode-'));
  try {
    const inputFile = join(dir, 'input');
    writeFileSync(inputFile, input, { mode: 0o600 });

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputFile,
      '-vn',
      '-sn',
      '-dn',
      '-t',
      String(maxSeconds),
      '-ac',
      '1',
      '-ar',
      String(DECODE_SAMPLE_RATE),
      '-f',
      'f32le',
      '-acodec',
      'pcm_f32le',
      'pipe:1',
    ];

    return await new Promise<FfmpegDecoded>((resolve, reject) => {
      const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let outBytes = 0;
      let stderrTail = '';
      let settled = false;

      const finish = (err: Error | null, pcm?: Float32Array): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else if (pcm) {
          resolve({
            samples: pcm,
            sampleRate: DECODE_SAMPLE_RATE,
            capped: pcm.length >= maxSeconds * DECODE_SAMPLE_RATE,
          });
        }
      };

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(new Error(`ffmpeg tardo mas de ${timeoutMs}ms en leer el audio`));
      }, timeoutMs);
      timer.unref?.();

      child.stdout.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes > maxOutBytes) {
          child.kill('SIGKILL');
          finish(new Error('el audio decodificado supera el maximo permitido'));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        // Kept short on purpose: the tail is what names the real format problem.
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-500);
      });
      child.on('error', (err) => {
        finish(new Error(`no pude ejecutar ffmpeg: ${err.message}`));
      });
      child.on('close', (code) => {
        if (code !== 0) {
          const detail = stderrTail.trim().split('\n').pop()?.trim();
          finish(
            new Error(
              `no pude leer ese audio${detail ? `: ${detail}` : ' (no parece un fichero de sonido)'}`,
            ),
          );
          return;
        }
        const bytes = Buffer.concat(chunks);
        // f32le: 4 bytes per sample. ffmpeg never emits a partial sample, but a
        // truncated write would otherwise shift every sample after it.
        const usable = bytes.length - (bytes.length % 4);
        if (usable === 0) {
          // Reached only when ffmpeg succeeded and produced nothing (a container
          // with no audio stream): a true fact, never a guess at a failed read.
          finish(new Error('ese audio no tiene pista de sonido'));
          return;
        }
        const pcm = new Float32Array(usable / 4);
        for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readFloatLE(i * 4);
        finish(null, pcm);
      });
    });
  } finally {
    // Success, decode error, timeout or spawn failure: the temp audio never
    // outlives its read.
    rmSync(dir, { recursive: true, force: true });
  }
}
