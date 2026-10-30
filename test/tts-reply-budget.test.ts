import { describe, expect, it, vi } from 'vitest';
import { speakWithin, type Tts, type TtsAudio } from '../src/voice/tts.js';

const audio: TtsAudio = {
  durationSeconds: 1,
  data: Buffer.from('mp3'),
  mimeType: 'audio/mpeg',
  format: 'mp3',
  text: 'hola',
  truncated: false,
};

describe('speakWithin: la respuesta escrita no espera a una voz colgada', () => {
  it('devuelve el audio si la voz llega a tiempo', async () => {
    const tts: Tts = { name: 'fake', speak: async () => audio };
    expect(await speakWithin(tts, 'hola', 1_000)).toBe(audio);
  });

  it('pasado el tope devuelve null, cancela la síntesis y lo explica', async () => {
    let signal: AbortSignal | undefined;
    const tts: Tts = {
      name: 'colgado',
      speak: (_text, opts) => {
        signal = opts?.signal;
        return new Promise(() => {});
      },
    };
    const onSkip = vi.fn();
    const started = Date.now();
    expect(await speakWithin(tts, 'hola', 30, onSkip)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(signal?.aborted).toBe(true);
    expect(onSkip).toHaveBeenCalledWith(expect.stringContaining('no estuvo lista'));
  });

  it('si la síntesis falla devuelve null con el motivo, sin lanzar', async () => {
    const tts: Tts = {
      name: 'roto',
      speak: async () => {
        throw new Error('la sintesis de voz fallo: sin voces');
      },
    };
    const onSkip = vi.fn();
    expect(await speakWithin(tts, 'hola', 1_000, onSkip)).toBeNull();
    expect(onSkip).toHaveBeenCalledWith('la sintesis de voz fallo: sin voces');
  });

  it('la respuesta a una nota de voz usa el tope (cableado en cli.ts)', async () => {
    const { readFileSync } = await import('node:fs');
    const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).toContain('speakWithin(tts, trimForSpeech(text), REPLY_TTS_BUDGET_MS');
    expect(cli).not.toContain('await tts.speak(trimForSpeech(text))');
  });
});
