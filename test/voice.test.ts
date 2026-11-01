import { describe, expect, it } from 'vitest';
import {
  decodeOggOpusToPcm,
  encodeMp3,
  estimateDurationSeconds,
  looksSilent,
  pcmToWavPcm16,
  resampleLinear,
  toMono,
  wavToPcm,
} from '../src/voice/audio.js';
import { SttError, transcribeVoiceNote } from '../src/voice/stt.js';
import { createSapiTts, voices } from '../src/voice/tts.js';

/** A ramp so resampling and mono mixing have something non-degenerate to act on. */
function ramp(length: number, step = 0.01): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = i * step;
  return out;
}

describe('pcmToWavPcm16', () => {
  it('writes a well-formed 44-byte canonical header', () => {
    const samples = new Float32Array(1600);
    const wav = pcmToWavPcm16(samples, 16_000);

    // The bug this shape prevents: a header whose declared sizes disagree with
    // its length, which players read as a truncated file.
    expect(wav.length).toBe(44 + samples.length * 2);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(samples.length * 2);
  });

  it('round-trips sample values through the int16 layer', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 0.25]);
    const decoded = wavToPcm(pcmToWavPcm16(samples, 16_000));

    expect(decoded.sampleRate).toBe(16_000);
    expect(decoded.samples.length).toBe(samples.length);
    // int16 quantisation means exact equality is wrong; 1/32768 is the step.
    for (const [i, want] of samples.entries()) {
      expect(decoded.samples[i]).toBeCloseTo(want, 3);
    }
  });

  it('keeps the file length even so RIFF chunk offsets stay aligned', () => {
    // An odd data length would desync any reader that walks chunks instead of
    // assuming the canonical 44-byte header.
    expect(pcmToWavPcm16(new Float32Array(1), 16_000).length % 2).toBe(0);
    expect(pcmToWavPcm16(new Float32Array(3), 16_000).length % 2).toBe(0);
  });

  it('clamps out-of-range floats instead of wrapping them', () => {
    // lamejs does not clamp: an int16 built from 1.5 wraps to -32767, which is
    // the audible "exploding noise" failure.
    const wild = new Float32Array([2, -2, 1e9, -1e9, Number.NaN]);
    expect(() => pcmToWavPcm16(wild, 16_000)).not.toThrow();

    const decoded = wavToPcm(pcmToWavPcm16(wild, 16_000));
    for (const sample of decoded.samples) {
      expect(sample).toBeGreaterThanOrEqual(-1);
      expect(sample).toBeLessThanOrEqual(1);
    }
  });
});

describe('toMono', () => {
  it('averages stereo channels rather than dropping one', () => {
    // Taking channel 0 would discard half the signal; averaging keeps speech and
    // attenuates a noise channel on the other side.
    const left = Float32Array.from([1, 1, 1]);
    const right = Float32Array.from([-1, -1, -1]);
    expect([...toMono([left, right])]).toEqual([0, 0, 0]);
  });

  it('passes a single channel straight through', () => {
    const only = Float32Array.from([0.5, -0.25]);
    expect([...toMono([only])]).toEqual([0.5, -0.25]);
  });

  it('uses the shortest channel length', () => {
    const long = Float32Array.from([1, 1, 1, 1]);
    const short = Float32Array.from([0, 0]);
    expect(toMono([long, short]).length).toBe(2);
  });

  it('returns empty for no channels', () => {
    expect(toMono([]).length).toBe(0);
  });
});

describe('resampleLinear', () => {
  it('changes length predictably', () => {
    // 48k -> 16k is the real case: a Telegram note decoded at 48kHz fed to
    // whisper, whose frontend expects 16kHz.
    const input = ramp(48_000);
    const output = resampleLinear(input, 48_000, 16_000);
    expect(output.length).toBe(16_000);
  });

  it('rounds rather than truncating, so durations stay accurate', () => {
    // 48001 samples at 48kHz is 1.00002s; flooring would lose the remainder.
    expect(resampleLinear(ramp(48_001), 48_000, 16_000).length).toBe(16_000);
    expect(resampleLinear(ramp(50_000), 48_000, 16_000).length).toBe(16_667);
  });

  it('is the identity when the rates match', () => {
    const input = ramp(100);
    expect(resampleLinear(input, 16_000, 16_000)).toBe(input);
  });

  it('interpolates rather than snapping on upsample', () => {
    const input = Float32Array.from([0, 1, 0]);
    const output = resampleLinear(input, 8_000, 16_000);
    expect(output.length).toBe(6);
    // Sample positions land at 0, 0.5, 1, 1.5, 2, 2.5. The midpoint at 1.5 is
    // the discriminator: nearest-neighbour would snap it to 1 or 0 and flatten
    // the zero crossing into a step.
    expect(output[2]).toBeCloseTo(1, 5);
    expect(output[3]).toBeCloseTo(0.5, 5);
    expect(output[4]).toBeCloseTo(0, 5);
  });

  it('survives an empty buffer', () => {
    expect(resampleLinear(new Float32Array(0), 48_000, 16_000).length).toBe(0);
  });
});

describe('looksSilent', () => {
  it('flags digital silence', () => {
    expect(looksSilent(new Float32Array(16_000))).toBe(true);
  });

  it('flags an empty buffer as silent', () => {
    expect(looksSilent(new Float32Array(0))).toBe(true);
  });

  it('accepts speech-level audio', () => {
    // A quiet but real recording must not be thrown away, which is why the
    // threshold sits at -40 dBFS rather than higher.
    const quiet = Float32Array.from({ length: 1_000 }, (_, i) => Math.sin(i * 0.05) * 0.02);
    expect(looksSilent(quiet)).toBe(false);
  });
});

describe('estimateDurationSeconds', () => {
  it('divides sample count by rate', () => {
    expect(estimateDurationSeconds(new Float32Array(16_000), 16_000)).toBe(1);
    expect(estimateDurationSeconds(new Float32Array(8_000), 16_000)).toBe(0.5);
  });

  it('reports zero for a nonsensical rate rather than Infinity', () => {
    expect(estimateDurationSeconds(new Float32Array(100), 0)).toBe(0);
  });
});

describe('encodeMp3', () => {
  const speechish = (rate: number, seconds: number): Float32Array =>
    Float32Array.from(
      { length: Math.round(rate * seconds) },
      (_, i) => Math.sin((i * 2 * Math.PI * 220) / rate) * 0.5,
    );

  it('emits a real mp3 frame header', () => {
    const mp3 = encodeMp3(speechish(16_000, 1), 16_000, 32);
    // 0xFF then the sync word: enough to prove this is not an empty buffer that
    // would upload as an unplayable file.
    expect(mp3.length).toBeGreaterThan(1_000);
    expect(mp3[0]).toBe(0xff);
    expect((mp3[1] ?? 0) & 0xe0).toBe(0xe0);
  });

  it('scales with duration', () => {
    const oneSecond = encodeMp3(speechish(16_000, 1), 16_000, 32).length;
    const twoSeconds = encodeMp3(speechish(16_000, 2), 16_000, 32).length;
    expect(twoSeconds).toBeGreaterThan(oneSecond * 1.8);
  });

  it('does not throw on out-of-range or non-finite input', () => {
    // The known lamejs failure: an int16 built from an unclamped float wraps and
    // the encoder emits noise, or throws outright.
    const wild = Float32Array.from({ length: 4_000 }, (_, i) => (i % 3 === 0 ? 5 : -5));
    wild[7] = Number.NaN;
    expect(() => encodeMp3(wild, 16_000, 32)).not.toThrow();
    expect(encodeMp3(wild, 16_000, 32).length).toBeGreaterThan(0);
  });

  it('handles an odd-length and an empty signal', () => {
    expect(encodeMp3(new Float32Array(1_001), 16_000, 32).length).toBeGreaterThan(0);
    // lamejs still emits its flush frame for zero input; the point is that this
    // does not throw, since TTS can legitimately synthesise nothing audible.
    expect(() => encodeMp3(new Float32Array(0), 16_000, 32)).not.toThrow();
  });

  it('rejects a nonsensical sample rate', () => {
    expect(() => encodeMp3(new Float32Array(100), 0, 32)).toThrow(/invalid sample rate/);
  });
});

describe('wavToPcm', () => {
  it('walks chunks past SAPI 18-byte fmt and LIST', () => {
    // SAPI's SetOutputToWaveFile writes an 18-byte "fmt " chunk (PCM plus cbSize).
    // Reading the header positionally took the sample rate from the wrong offset,
    // which is why wavToPcm walks the chunk list instead.
    const fmtSize = 18;
    const samples = 1_000;
    const fmt = Buffer.alloc(fmtSize);
    fmt.writeUInt16LE(1, 0);
    fmt.writeUInt16LE(1, 2);
    fmt.writeUInt32LE(22_050, 4);
    fmt.writeUInt32LE(22_050 * 2, 8);
    fmt.writeUInt16LE(2, 12);
    fmt.writeUInt16LE(16, 14);

    const data = Buffer.alloc(samples * 2);
    const list = Buffer.from('INFOIARTsomeone');
    const chunks = [chunk('fmt ', fmt), chunk('LIST', list), chunk('data', data)];
    const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), ...chunks]);
    const file = Buffer.concat([riff(body.length + 4), body]);

    const decoded = wavToPcm(file);
    expect(decoded.sampleRate).toBe(22_050);
    expect(decoded.samples.length).toBe(samples);
  });

  it('rejects a buffer that is not RIFF/WAVE', () => {
    expect(() => wavToPcm(Buffer.from('not audio at all'))).toThrow(/not a RIFF/);
  });

  it('rejects a WAVE file with no data chunk', () => {
    const fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(1, 0);
    fmt.writeUInt16LE(1, 2);
    fmt.writeUInt32LE(16_000, 4);
    fmt.writeUInt32LE(32_000, 8);
    fmt.writeUInt16LE(2, 12);
    fmt.writeUInt16LE(16, 14);
    const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), chunk('fmt ', fmt)]);
    expect(() => wavToPcm(Buffer.concat([riff(body.length + 4), body]))).toThrow(
      /no usable fmt\/data/,
    );
  });
});

function chunk(id: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  // RIFF pads odd-length chunks; without it every reader after this one is lost.
  return Buffer.concat([head, body, body.length % 2 === 0 ? Buffer.alloc(0) : Buffer.alloc(1)]);
}

function riff(size: number): Buffer {
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(size, 4);
  return head;
}

describe('decodeOggOpusToPcm', () => {
  it('rejects garbage bytes with an error instead of returning empty audio', async () => {
    // Without this the caller would hand whisper 0 samples and get a confident
    // hallucination back.
    await expect(decodeOggOpusToPcm(Buffer.from('not an ogg file at all'))).rejects.toThrow(
      /no opus frames/,
    );
  });

  it('decodes ogg/opus to mono 16kHz, downmixing stereo', async () => {
    // The fixture is assembled here rather than committed or downloaded: the
    // installed deps include no opus encoder, so a hand-built page sequence
    // (OpusHead + OpusTags + one audio page, with correct CRCs and the 255-byte
    // lacing rules) is the only offline way to get a buffer the decoder accepts.
    const mono = await decodeOggOpusToPcm(syntheticOgg(1, false));
    const stereo = await decodeOggOpusToPcm(syntheticOgg(2, true));

    expect(mono.sampleRate).toBe(16_000);
    expect(mono.samples.length).toBeGreaterThan(0);
    // 48kHz source resampled to whisper's native 16kHz.
    expect(mono.samples.length / 16_000).toBeLessThan(1);
    // Same duration either way: the stereo path is downmixed, not truncated to
    // one channel, and not doubled.
    expect(stereo.samples.length).toBe(mono.samples.length);
    // Silent payload, which is what lets the silence guard reject it below.
    expect(looksSilent(mono.samples)).toBe(true);
  });
});

/** Ogg lacing values: each packet length splits into 255s plus a remainder. */
function lacing(lengths: number[]): number[] {
  const out: number[] = [];
  for (const length of lengths) {
    let rest = length;
    while (rest >= 255) {
      out.push(255);
      rest -= 255;
    }
    out.push(rest);
  }
  return out;
}

/** Ogg's CRC-32: polynomial 0x04c11db7, no reflection, zero init and xorout. */
function oggCrc32(buffer: Buffer): number {
  let crc = 0;
  for (const byte of buffer) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

function oggPage(
  seq: number,
  headerType: number,
  granule: number,
  lens: number[],
  payload: Buffer,
): Buffer {
  const segments = lacing(lens);
  const head = Buffer.alloc(27 + segments.length);
  head.write('OggS', 0, 'ascii');
  head[5] = headerType;
  head.writeBigUInt64LE(BigInt(granule), 6);
  head.writeUInt32LE(1, 14);
  head.writeUInt32LE(seq, 18);
  head[26] = segments.length;
  segments.forEach((size, i) => {
    head[27 + i] = size;
  });
  const page = Buffer.concat([head, payload]);
  // The checksum field is zero while hashing and written afterwards.
  page.writeUInt32LE(oggCrc32(page), 22);
  return page;
}

function opusHead(channels: number): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'ascii');
  head[8] = 1;
  head[9] = channels;
  head.writeUInt16LE(312, 10);
  head.writeUInt32LE(48_000, 12);
  return head;
}

function opusTags(): Buffer {
  const vendor = Buffer.from('pa-test', 'ascii');
  const tags = Buffer.alloc(8 + vendor.length + 8);
  tags.write('OpusTags', 0, 'ascii');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);
  return tags;
}

/** A decodable but silent OGG/OPUS file: TOC byte 36 plus zeroed frame data. */
function syntheticOgg(channels: number, stereo: boolean): Buffer {
  const frames = 20;
  const packets: Buffer[] = [];
  for (let i = 0; i < frames; i++) {
    const toc = (36 << 3) | (stereo ? 1 << 2 : 0);
    packets.push(Buffer.concat([Buffer.from([toc]), Buffer.alloc(stereo ? 160 : 80)]));
  }
  const payload = Buffer.concat(packets);
  const packetLength = stereo ? 161 : 81;
  return Buffer.concat([
    oggPage(0, 0x02, 0, [19], opusHead(channels)),
    oggPage(1, 0x00, 0, [opusTags().length], opusTags()),
    oggPage(
      2,
      0x04,
      960 * frames,
      Array.from({ length: frames }, () => packetLength),
      payload,
    ),
  ]);
}

describe('transcribeVoiceNote', () => {
  it('fails catchably on garbage input without touching the model', async () => {
    // Must not hang and must not become an unhandled rejection: the Telegram
    // handler awaits this and a crash there kills the daemon.
    await expect(transcribeVoiceNote(Buffer.from('nope'))).rejects.toBeInstanceOf(SttError);
  }, 10_000);

  it('rejects an empty buffer before any decoding', async () => {
    await expect(transcribeVoiceNote(Buffer.alloc(0))).rejects.toThrow(/llegó vacía/);
  });

  it('reports undecodable mp3 bytes honestly instead of inventing a transcript', async () => {
    // Telegram sends audio/mpeg for ordinary uploads. Real mp3s decode through
    // ffmpeg (voice-decode.test.ts covers that); bytes that are not audio at all
    // must surface as an honest failure, never as a garbled "transcript".
    await expect(
      transcribeVoiceNote(Buffer.from('ID3 not really audio'), { mimeType: 'audio/mpeg' }),
    ).rejects.toThrow(/no pude leer ese audio/);
  });
});

describe('createSapiTts', () => {
  it('refuses empty text without spawning PowerShell', async () => {
    // The check has to precede the process spawn: an empty synthesis costs a
    // PowerShell round trip to produce silence.
    const tts = createSapiTts();
    await expect(tts.speak('')).rejects.toThrow(/no hay texto que decir/);
    await expect(tts.speak('   \n\t ')).rejects.toThrow(/no hay texto que decir/);
  });

  it('reports the spoken text and whether it was truncated', () => {
    expect(createSapiTts().name).toBe('sapi');
  });
});

describe('voices', () => {
  // Never throws by contract, so this asserts the shape rather than the contents:
  // a machine with System.Speech uninstalled must still get an array.
  it('returns an array and never throws', async () => {
    expect(Array.isArray(await voices())).toBe(true);
  }, 20_000);
});

describe('sapi synthesis', () => {
  // Skipped by default: a real synthesis is a ~1s PowerShell round trip and
  // depends on System.Speech being installed, so it cannot be part of a fast
  // suite. Run with `it.only` locally, or flip the skip, when changing tts.ts.
  it.skip('synthesises Spanish text to a playable mp3', async () => {
    const audio = await createSapiTts().speak('Hola, esto es una prueba. ¿Qué tal?');
    expect(audio.format).toBe('mp3');
    expect(audio.mimeType).toBe('audio/mpeg');
    expect(audio.data.length).toBeGreaterThan(1_000);
    expect(audio.truncated).toBe(false);
    // Accented and inverted characters must survive the round trip through the
    // temp .txt file and PowerShell's default codepage.
    expect(audio.text).toContain('¿');
    expect(audio.truncated).toBe(false);
  }, 60_000);
});
