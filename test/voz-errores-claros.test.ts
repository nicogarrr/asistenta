import { describe, expect, it, vi } from 'vitest';

// Sin red ni modelo de verdad: el decodificador devuelve voz falsa y la descarga del modelo falla.
const state = vi.hoisted(() => ({ err: new Error('x') as unknown }));
vi.mock('../src/voice/decode.js', () => ({
  decodeForWhisper: async () => ({
    samples: Float32Array.from({ length: 16_000 }, (_, i) => 0.3 * Math.sin(i / 5)),
    sampleRate: 16_000,
  }),
}));
vi.mock('@huggingface/transformers', () => ({
  LogLevel: { ERROR: 40 },
  env: {},
  pipeline: async () => {
    throw state.err;
  },
}));

import { failedReply, forwardedAudioFailNote } from '../src/cli.js';
import { SttError, transcribeVoiceNote } from '../src/voice/stt.js';

const nota = Buffer.from('OggS falso');

describe('nota de voz: errores en castellano claro', () => {
  it('sin internet la primera vez: dice que hace falta conexión, no «error interno»', async () => {
    for (const err of [
      new TypeError('fetch failed'),
      new Error(
        'Could not locate file: "https://huggingface.co/onnx-community/x/resolve/main/config.json".',
      ),
    ]) {
      state.err = err;
      const caught = await transcribeVoiceNote(nota).catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(SttError);
      const reply = failedReply('No he entendido la nota de voz', caught);
      expect(reply).toMatch(/necesita internet/);
      expect(reply).not.toMatch(/fetch failed|https?:|error interno|SttError/);
    }
  });

  it('un fallo desconocido no lleva el texto técnico al chat', async () => {
    state.err = new Error('Protobuf parsing failed at /home/x/encoder.onnx');
    const caught = await transcribeVoiceNote(nota).catch((e: unknown) => e);
    const reply = failedReply('No he entendido la nota de voz', caught);
    expect(reply).toBe(
      'No he entendido la nota de voz: no pude transcribir la nota de voz. Prueba otra vez en un momento',
    );
  });

  it('el aviso de nota vacía lleva tildes y no enseña «SttError»', () => {
    const reply = failedReply(
      'No he entendido la nota de voz',
      new SttError('la nota de voz está vacía o en silencio'),
    );
    expect(reply).toBe('No he entendido la nota de voz: la nota de voz está vacía o en silencio');
  });

  it('audio enviado como archivo: la nota para el modelo no lleva el error crudo', () => {
    const note = forwardedAudioFailNote(
      'reunion.mp3',
      new Error("ENOENT: no such file or directory, open 'C:\\Users\\nico\\models\\encoder.onnx'"),
    );
    expect(note).toBe(
      '[Audio reenviado: reunion.mp3. No se pudo transcribir: falta el archivo «encoder.onnx» en el PC.]',
    );
    expect(note).not.toMatch(/ENOENT|C:\\/);
  });
});
