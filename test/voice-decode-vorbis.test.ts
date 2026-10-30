import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { describe, expect, it } from 'vitest';
import { pcmToWavPcm16 } from '../src/voice/audio.js';
import { decodeForWhisper, ffmpegDecoderAvailable } from '../src/voice/decode.js';

const FFMPEG = ffmpegDecoderAvailable();
const BIN: string | null =
  typeof ffmpegStatic === 'string'
    ? ffmpegStatic
    : ((ffmpegStatic as { default?: string }).default ?? null);

function vorbisOgg(seconds: number): Buffer {
  if (!BIN) throw new Error('no ffmpeg');
  const dir = mkdtempSync(join(tmpdir(), 'pa-test-vorbis-'));
  try {
    const rate = 16_000;
    const pcm = new Float32Array(seconds * rate);
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
    const wav = join(dir, 'in.wav');
    const ogg = join(dir, 'out.ogg');
    writeFileSync(wav, pcmToWavPcm16(pcm, rate));
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'libvorbis', ogg];
    let res = spawnSync(BIN, args);
    if (res.status !== 0) {
      // Binario sin libvorbis: el codificador nativo también produce Vorbis.
      res = spawnSync(BIN, [
        ...args.slice(0, -3),
        '-c:a',
        'vorbis',
        '-strict',
        '-2',
        '-ac',
        '2',
        ogg,
      ]);
    }
    if (res.status !== 0) throw new Error(`fixture vorbis failed: ${res.stderr}`);
    return readFileSync(ogg);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('decodeForWhisper con ogg que no es opus', () => {
  it.runIf(FFMPEG)(
    'un .ogg Vorbis etiquetado audio/ogg se transcribe vía ffmpeg en vez de rechazarse',
    async () => {
      const decoded = await decodeForWhisper(vorbisOgg(1), 'audio/ogg');
      expect(decoded.sampleRate).toBe(16_000);
      expect(decoded.samples.length).toBeGreaterThan(12_000);
    },
    30_000,
  );
});
