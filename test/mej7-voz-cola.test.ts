import { describe, expect, it } from 'vitest';
import { pcmToWavPcm16 } from '../src/voice/audio.js';
import { encodeSpeech } from '../src/voice/tts.js';

// voz-2/voz-4: «tienes» se oía «tiene». La última sílaba caía en el último frame mp3,
// pegada al final del archivo, y el reproductor la cortaba. Ahora cada audio lleva
// ~150 ms de silencio detrás: el mp3 cubre toda la voz, más el retardo del codificador.

const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR1 = [44_100, 48_000, 32_000];
const SR2 = [22_050, 24_000, 16_000];

/** Segundos que trae el mp3, contando sus frames (Layer III, MPEG-1 y MPEG-2). */
function segundosMp3(mp3: Buffer): number {
  let i = 0;
  let muestras = 0;
  let hz = 0;
  while (i + 4 <= mp3.length) {
    const b1 = mp3[i + 1] ?? 0;
    const b2 = mp3[i + 2] ?? 0;
    if (mp3[i] !== 0xff || (b1 & 0xe0) !== 0xe0) {
      i++;
      continue;
    }
    const mpeg1 = (b1 & 0x18) === 0x18;
    const kbps = (mpeg1 ? BR1 : BR2)[b2 >> 4] ?? 0;
    hz = (mpeg1 ? SR1 : SR2)[(b2 >> 2) & 3] ?? 0;
    if (!kbps || !hz) {
      i++;
      continue;
    }
    const porFrame = mpeg1 ? 1152 : 576;
    i += Math.floor(((porFrame / 8) * kbps * 1000) / hz) + ((b2 >> 1) & 1);
    muestras += porFrame;
  }
  return hz ? muestras / hz : 0;
}

function voz(hz: number, segundos: number): Float32Array {
  const n = Math.round(hz * segundos);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.4 * Math.sin((2 * Math.PI * 300 * i) / hz);
  return out;
}

describe('voz: el final de la frase no se corta en el mp3', () => {
  for (const hz of [24_000, 44_100, 22_050]) {
    it(`a ${hz} Hz el mp3 dura toda la voz + retardo del codificador + 100 ms de cola`, () => {
      const a = encodeSpeech(pcmToWavPcm16(voz(hz, 1), hz), '¿Qué tienes?', '¿Qué tienes?');
      // Retardo de lame ≈ 1105 muestras; se descuenta un frame por si es de cabecera.
      const util = segundosMp3(a.data) - 1152 / hz - 1105 / hz;
      expect(util).toBeGreaterThanOrEqual(1 + 0.1);
      expect(a.durationSeconds).toBeCloseTo(1, 2);
    });
  }
});
