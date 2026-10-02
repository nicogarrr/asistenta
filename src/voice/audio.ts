/**
 * Audio helpers for the offline voice path. Pure buffer work, no I/O beyond the
 * files the caller hands us, so the STT and TTS paths can be reasoned about (and
 * tested) without spawning anything.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Whisper's native sample rate. Everything handed to the model is resampled to this. */
export const WHISPER_SAMPLE_RATE = 16_000;

/**
 * RMS below this counts as silence (-40 dBFS).
 *
 * Telegram voice notes that arrive silent are a real case: the record button can
 * be tapped and released without capturing anything, and the opus decoder happily
 * returns thousands of near-zero samples. Running whisper over that spends a full
 * inference pass to produce a hallucinated sentence, which is worse than saying
 * nothing at all. The threshold is deliberately low so a genuinely quiet
 * recording still clears it; what is being rejected is digital silence and its
 * immediate neighbours.
 */
const SILENCE_RMS = 0.01;

/**
 * Samples per MP3 frame. lamejs sizes its output buffer from the first chunk it
 * is handed and only ever grows it, so feeding 1152 at a time keeps every call
 * inside the buffer it already allocated (`src/js/index.js`).
 */
const MP3_CHUNK_SAMPLES = 1152;

/** The slice of lamejs we use. lamejs ships no types and its entry point is broken (see `loadLame`). */
interface LameMp3Encoder {
  encodeBuffer(left: Int16Array, right: Int16Array): Int8Array;
  flush(): Int8Array;
}

interface LameNamespace {
  Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => LameMp3Encoder;
}

export interface DecodedPcm {
  samples: Float32Array;
  sampleRate: number;
}

let lame: LameNamespace | null = null;

/**
 * Load lamejs from its prebuilt browser bundle.
 *
 * `require('lamejs')` is broken under Node: `src/js/index.js` constructs the
 * encoder, which reaches for free variables (`MPEGMode`, `Lame`, ...) that only
 * exist as globals in the concatenated browser build. Under Node those lookups
 * throw `ReferenceError: MPEGMode is not defined` on the very first encode. The
 * two ways around it are pinning ~30 undocumented internal modules onto
 * `globalThis` (breaks on any version bump) or evaluating the one shipped bundle
 * and returning its `lamejs` namespace, which is what we do.
 *
 * `new Function` rather than `vm` so the bundle's declarations stay scoped to
 * that one call and nothing leaks onto our global object, which the vm route
 * needed a context and explicit cleanup for.
 */
function loadLame(): LameNamespace {
  if (lame) return lame;
  const source = readFileSync(require.resolve('lamejs/lame.min.js'), 'utf8');
  lame = new Function(`${source}\nreturn lamejs;`)() as LameNamespace;
  return lame;
}

/**
 * Average N channels into one.
 *
 * Telegram voice notes are single-channel opus, but the same decoder is used for
 * whatever a channel hands us and opus files can be stereo. Whisper is mono-only,
 * and averaging beats picking channel 0: on a stereo recording with a voice on
 * one side and noise on the other, taking one channel silently throws away half
 * the signal, while averaging keeps the speech and attenuates the noise.
 */
export function toMono(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;

  // Shortest channel wins the length: interpolating past the end of a channel
  // would invent samples that were never recorded.
  let length = first.length;
  for (const channel of channels) length = Math.min(length, channel.length);

  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0) / channels.length;
  }
  return mono;
}

/**
 * Linear-interpolation resampler.
 *
 * Linear rather than windowed-sinc on purpose: this runs once per voice note on
 * speech that opus has already band-limited, and the output rate (16kHz) is half
 * the input, so the images linear interpolation puts at the old Nyquist land
 * above 8kHz where whisper's filterbank has no bins anyway. A proper resampler
 * would cost more CPU for no measurable accuracy on this material.
 */
export function resampleLinear(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const length = Math.round((samples.length * to) / from);
  const out = new Float32Array(length);
  if (length === 0) return out;

  const ratio = from / to;
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, samples.length - 1);
    const frac = position - left;
    out[i] = (samples[left] ?? 0) * (1 - frac) + (samples[right] ?? 0) * frac;
  }
  return out;
}

/**
 * Decode an OGG/OPUS buffer to mono 16kHz float PCM.
 *
 * Telegram voice notes are opus, which the decoder reports at 48kHz. We downmix
 * and resample to 16kHz here rather than feeding whisper the native rate:
 * whisper's log-mel filterbank is defined for 16kHz windows, so a 48kHz input is
 * resampled inside the feature extractor anyway, only with a worse filter, and
 * handing it 16kHz up front is also a third of the samples to run the encoder
 * over, which is most of the inference cost.
 */
export async function decodeOggOpusToPcm(data: Buffer): Promise<DecodedPcm> {
  const { OggOpusDecoder } = await import('ogg-opus-decoder');
  const decoder = new OggOpusDecoder();
  try {
    await decoder.ready;
    const decoded = await decoder.decodeFile(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
    if (decoded.samplesDecoded === 0 || decoded.channelData.length === 0) {
      throw new Error('no opus frames in the buffer');
    }
    const mono = toMono(decoded.channelData);
    return {
      samples: resampleLinear(mono, decoded.sampleRate, WHISPER_SAMPLE_RATE),
      sampleRate: WHISPER_SAMPLE_RATE,
    };
  } finally {
    decoder.free();
  }
}

/**
 * 44-byte canonical RIFF header for 16-bit signed PCM.
 *
 * The odd-length pad is not theoretical: RIFF requires every chunk to start on an
 * even offset, and a file whose `data` length is odd desynchronises every reader
 * that walks chunks instead of assuming the canonical 44-byte layout (which is
 * what Telegram's own audio handling does).
 */
function riffHeader(dataBytes: number, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataLength = dataBytes % 2 === 0 ? dataBytes : dataBytes + 1;

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** Wrap float PCM in a mono 16-bit WAV container. */
export function pcmToWavPcm16(samples: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(toInt16(samples[i] ?? 0), i * 2);
  }
  const body = data.length % 2 === 0 ? data : Buffer.concat([data, Buffer.alloc(1)]);
  return Buffer.concat([riffHeader(data.length, sampleRate), body]);
}

/**
 * Float [-1, 1] to int16 with clamping.
 *
 * lamejs does not clamp for us: an int16 built from an out-of-range float wraps
 * around (1.5 becomes -32767), which is the audible "exploding noise" failure.
 * Input reaching this function comes from opus decode and from microphone capture
 * downstream, so overflow is expected occasionally rather than never.
 */
function toInt16(sample: number): number {
  if (!(sample > -1)) return sample < -1 ? -32768 : 0;
  return sample >= 1 ? 32767 : Math.round(sample * 32767);
}

/**
 * Encode float PCM to MP3 with lamejs.
 *
 * Mono at 24-32kbps is the right target for speech sent over chat: above ~32kbps
 * a mono speech signal is encoded into padding, and below ~24kbps the artefacts
 * become audible in the 4-8kHz band where sibilants live. Keeping the payload
 * small matters because a Telegram voice message has a 50MB ceiling that we would
 * rather not spend on silence.
 */
export function encodeMp3(pcm: Float32Array, sampleRate: number, kbps = 32): Buffer {
  if (!(sampleRate > 0)) throw new Error(`invalid sample rate: ${sampleRate}`);

  const data = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) data[i] = toInt16(pcm[i] ?? 0);

  // libmp3lame's own accepted range is 8-320; clamping beats passing it a rate it
  // rejects by returning an error code the JS port then asserts on.
  const encoder = new (loadLame().Mp3Encoder)(
    1,
    sampleRate,
    Math.max(8, Math.min(320, Math.round(kbps))),
  );
  const parts: Buffer[] = [];

  for (let offset = 0; offset < data.length; offset += MP3_CHUNK_SAMPLES) {
    const chunk = data.subarray(offset, Math.min(offset + MP3_CHUNK_SAMPLES, data.length));
    // Subarrays, not copies: the final chunk is usually short and copying the
    // whole signal per frame would dominate encode time on long audio.
    parts.push(Buffer.from(encoder.encodeBuffer(chunk, chunk)));
  }
  parts.push(Buffer.from(encoder.flush()));
  return Buffer.concat(parts);
}

/** Seconds of audio in a float PCM buffer. */
export function estimateDurationSeconds(samples: Float32Array, sampleRate: number): number {
  if (sampleRate <= 0) return 0;
  return samples.length / sampleRate;
}

/**
 * Whether a buffer is silence by RMS.
 *
 * Cheap on purpose: this runs before the model is touched, so a full pass over
 * the samples is worth it if it saves an inference.
 */
export function looksSilent(pcm: Float32Array): boolean {
  if (pcm.length === 0) return true;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += (pcm[i] ?? 0) ** 2;
  return Math.sqrt(sum / pcm.length) < SILENCE_RMS;
}

/**
 * Parse a RIFF/WAVE file into float PCM.
 *
 * Chunk walking rather than assuming the canonical 44-byte header. SAPI's
 * `SetOutputToWaveFile` does not write one: it emits an 18-byte `fmt ` chunk
 * (PCM plus a trailing `cbSize` field), verified on this machine at 22050Hz mono.
 * Reading the header positionally therefore reads the sample rate from inside
 * `cbSize`, which is why this walks the chunk list and only trusts fields it has
 * actually found at their declared offsets.
 */
export function wavToPcm(buffer: Buffer): DecodedPcm {
  if (
    buffer.length < 12 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('not a RIFF/WAVE buffer');
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let data: Buffer | null = null;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > buffer.length) break;

    if (id === 'fmt ' && size >= 16) {
      format = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
      // WAVE_FORMAT_EXTENSIBLE hides the real codec in the sub-format GUID.
      if (format === 0xfffe && size >= 40) format = buffer.readUInt16LE(body + 24);
    } else if (id === 'data') {
      data = buffer.subarray(body, body + size);
    }

    offset = body + size + (size % 2);
  }

  if (!data || channels < 1 || sampleRate < 1)
    throw new Error('WAVE buffer has no usable fmt/data chunks');
  return { samples: decodePcmSamples(data, format, bitsPerSample), sampleRate };
}

/** Turn packed sample bytes into floats, normalising to [-1, 1]. */
function decodePcmSamples(data: Buffer, format: number, bitsPerSample: number): Float32Array {
  const isFloat = format === 3;
  const width = bitsPerSample / 8;
  if (!isFloat && ![1, 2, 3, 4].includes(width)) {
    throw new Error(`unsupported WAVE sample format: ${bitsPerSample}-bit, tag ${format}`);
  }
  const count = Math.floor(data.length / width);
  const out = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const at = i * width;
    if (isFloat && width === 4) out[i] = data.readFloatLE(at);
    else if (isFloat && width === 8) out[i] = data.readDoubleLE(at);
    else if (width === 1) out[i] = (data.readUInt8(at) - 128) / 128;
    else if (width === 2) out[i] = data.readInt16LE(at) / 32768;
    else if (width === 3) {
      const raw = data.readUIntLE(at, 3);
      const signed = raw >= 0x800000 ? raw - 0x1000000 : raw;
      out[i] = signed / 8388608;
    } else out[i] = data.readInt32LE(at) / 2147483648;
  }
  return out;
}
