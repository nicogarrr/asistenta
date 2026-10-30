import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  createDefaultTts,
  createPiperTts,
  hasSpanishVoice,
  type PiperRunner,
  withFallback,
} from '../src/voice/piper.js';
import type { Tts, TtsAudio } from '../src/voice/tts.js';

/** WAV PCM16 mono de `seconds` segundos, lo que escribe Piper. */
function wav(seconds = 0.2, rate = 22050): Buffer {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), 44 + i * 2);
  return b;
}

const fakeRunner =
  (calls: Array<{ bin: string; args: string[]; input: string }>): PiperRunner =>
  async (bin, args, input) => {
    calls.push({ bin, args, input });
    writeFileSync(args[args.indexOf('--output_file') + 1] as string, wav());
  };

const fake = (name: string, fail = false): Tts & { calls: number } => {
  const t = {
    name,
    calls: 0,
    async speak(text: string): Promise<TtsAudio> {
      t.calls++;
      if (fail) throw new Error(`${name} roto`);
      return {
        durationSeconds: 1,
        data: Buffer.from(name),
        mimeType: 'audio/mpeg',
        format: 'mp3',
        text,
        truncated: false,
      };
    },
  };
  return t;
};

describe('Piper: voz local de respaldo', () => {
  it('pasa el texto por stdin con el modelo y devuelve mp3', async () => {
    const calls: Array<{ bin: string; args: string[]; input: string }> = [];
    const tts = createPiperTts({
      model: 'C:\\voces\\es_ES-davefx-medium.onnx',
      run: fakeRunner(calls),
    });
    const audio = await tts.speak('Hola,\nNico. ¿Qué tal?');
    expect(calls[0]?.bin).toBe('piper');
    expect(calls[0]?.args.slice(0, 2)).toEqual(['--model', 'C:\\voces\\es_ES-davefx-medium.onnx']);
    expect(calls[0]?.input).toBe('Hola, Nico. ¿Qué tal?');
    expect(audio.format).toBe('mp3');
    expect(audio.durationSeconds).toBeCloseTo(0.2, 1);
    expect(audio.data.length).toBeGreaterThan(0);
  });

  it('un fallo de Piper llega como error en español', async () => {
    const tts = createPiperTts({
      model: 'x.onnx',
      run: async () => {
        throw new Error('spawn piper ENOENT');
      },
    });
    await expect(tts.speak('hola')).rejects.toThrow(/la voz de Piper fallo: spawn piper ENOENT/);
  });

  it('detecta voces españolas de SAPI', () => {
    expect(hasSpanishVoice(['Microsoft Zira Desktop', 'Microsoft Helena Desktop'])).toBe(true);
    expect(hasSpanishVoice(['Microsoft Sabina Desktop - Spanish (Mexico)'])).toBe(true);
    expect(hasSpanishVoice(['Microsoft David Desktop', 'Microsoft Zira Desktop'])).toBe(false);
    expect(hasSpanishVoice([])).toBe(false);
  });

  it('withFallback usa el respaldo si el primero falla, pero no si se cancela', async () => {
    const a = fake('sapi', true);
    const b = fake('piper');
    const onFallback = vi.fn();
    expect((await withFallback(a, b, onFallback).speak('hola')).data.toString()).toBe('piper');
    expect(onFallback).toHaveBeenCalledOnce();
    const ctl = new AbortController();
    ctl.abort();
    await expect(withFallback(a, b).speak('hola', { signal: ctl.signal })).rejects.toThrow();
    expect(b.calls).toBe(1);
  });
});

describe('createDefaultTts: apagado por defecto', () => {
  it('sin PA_PIPER_MODEL es SAPI tal cual', () => {
    const sapi = fake('sapi');
    expect(createDefaultTts({}, { sapi })).toBe(sapi);
  });

  it('PA_TTS=piper fuerza Piper', () => {
    const piper = fake('piper');
    expect(
      createDefaultTts(
        { PA_PIPER_MODEL: 'x.onnx', PA_TTS: 'piper' },
        { sapi: fake('sapi'), piper },
      ),
    ).toBe(piper);
  });

  it('SAPI sin voz española (o sin SAPI): Piper primero', async () => {
    const sapi = fake('sapi');
    const piper = fake('piper');
    const tts = createDefaultTts(
      { PA_PIPER_MODEL: 'x.onnx' },
      { sapi, piper, listVoices: async () => ['Microsoft Zira Desktop'] },
    );
    expect((await tts.speak('hola')).data.toString()).toBe('piper');
    expect(sapi.calls).toBe(0);
  });

  it('SAPI con voz española: SAPI primero y Piper solo si falla', async () => {
    const sapi = fake('sapi', true);
    const piper = fake('piper');
    const listVoices = vi.fn(async () => ['Microsoft Helena Desktop']);
    const tts = createDefaultTts({ PA_PIPER_MODEL: 'x.onnx' }, { sapi, piper, listVoices });
    expect((await tts.speak('hola')).data.toString()).toBe('piper');
    await tts.speak('otra');
    expect(sapi.calls).toBe(2);
    expect(listVoices).toHaveBeenCalledOnce();
  });
});
