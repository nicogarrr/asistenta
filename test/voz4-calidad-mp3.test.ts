import { describe, expect, it } from 'vitest';
import { pcmToWavPcm16 } from '../src/voice/audio.js';
import { encodeSpeech } from '../src/voice/tts.js';

/** Frecuencia y bitrate de la primera trama MPEG-1/2 Layer III del mp3. */
function cabeceraMp3(buf: Buffer): { hz: number; kbps: number } {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] !== 0xff || ((buf[i + 1] ?? 0) & 0xe0) !== 0xe0) continue;
    const b1 = buf[i + 1] ?? 0;
    const b2 = buf[i + 2] ?? 0;
    const mpeg1 = ((b1 >> 3) & 3) === 3;
    const hz = (mpeg1 ? [44100, 48000, 32000] : [22050, 24000, 16000])[(b2 >> 2) & 3] ?? 0;
    const tabla = mpeg1
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    return { hz, kbps: tabla[b2 >> 4] ?? 0 };
  }
  throw new Error('sin trama mp3');
}

function tono(hz: number, segundos: number): Float32Array {
  const n = Math.round(hz * segundos);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / hz);
  return s;
}

describe('voz4: el mp3 de la voz conserva la calidad del motor', () => {
  it('Kokoro (24 kHz) sale a 24 kHz y ≥64 kbps, no rebajado a 16 kHz/32 kbps', () => {
    const a = encodeSpeech(pcmToWavPcm16(tono(24_000, 1), 24_000), 'hola', 'hola');
    const c = cabeceraMp3(a.data);
    expect(c.hz).toBe(24_000);
    expect(c.kbps).toBeGreaterThanOrEqual(64);
    expect(a.durationSeconds).toBeCloseTo(1, 1);
  });

  it('Piper/SAPI (22 050 Hz) sale a su frecuencia, sin remuestrear', () => {
    const c = cabeceraMp3(encodeSpeech(pcmToWavPcm16(tono(22_050, 1), 22_050), 'x', 'x').data);
    expect(c.hz).toBe(22_050);
  });

  it('una frecuencia rara (44,1 kHz) baja a 24 kHz', () => {
    const c = cabeceraMp3(encodeSpeech(pcmToWavPcm16(tono(44_100, 0.5), 44_100), 'x', 'x').data);
    expect(c.hz).toBe(24_000);
  });
});
