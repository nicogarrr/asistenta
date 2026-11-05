/**
 * Voz con tildes en la ruta: onnxruntime-node en Windows no abre un modelo en
 * «C:\\Users\\José\\…» (convierte la ruta con la página de códigos del sistema), así que el
 * VAD y la palabra de activación no arrancaban para un usuario con tilde o eñe en su nombre.
 * Ahora, con una ruta no ASCII, el modelo se lee con Node y se abre desde sus bytes; con
 * una ruta ASCII se abre por ruta, como antes. ort falso: se mira qué recibe `create`.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createOnnxSession, needsByteLoad } from '../src/voice/onnx-load.js';

function fakeOrt() {
  const got: Array<string | Uint8Array> = [];
  const ort = {
    InferenceSession: {
      create: async (arg: string | Uint8Array) => {
        got.push(arg);
        return { ok: true };
      },
    },
  };
  return { ort, got };
}

describe('modelos ONNX de voz en rutas con tildes', () => {
  it('detecta las rutas que Windows no abre: tildes, eñes, emojis, otros alfabetos', () => {
    expect(needsByteLoad('C:\\Users\\José\\.asistenta\\silero_vad.onnx')).toBe(true);
    expect(needsByteLoad('C:\\Users\\Begoña\\modelos\\hey.onnx')).toBe(true);
    expect(needsByteLoad('C:\\Users\\Алексей\\m.onnx')).toBe(true);
    expect(needsByteLoad('C:\\Users\\nico\\.asistenta\\silero_vad.onnx')).toBe(false);
    expect(needsByteLoad('/home/nico/modelos/melspectrogram.onnx')).toBe(false);
  });

  it('una ruta con tilde se lee con Node y se abre desde los bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voz-José-'));
    const file = join(dir, 'silero_vad.onnx');
    await writeFile(file, Buffer.from([1, 2, 3, 4]));
    const { ort, got } = fakeOrt();
    await createOnnxSession(ort, file);
    expect(got).toHaveLength(1);
    expect(got[0]).toBeInstanceOf(Uint8Array);
    expect([...(got[0] as Uint8Array)]).toEqual([1, 2, 3, 4]);
  });

  it('una ruta ASCII se sigue abriendo por ruta (sin leer el fichero)', async () => {
    const { ort, got } = fakeOrt();
    let read = 0;
    await createOnnxSession(ort, 'C:\\Users\\nico\\m.onnx', async () => {
      read++;
      return new Uint8Array();
    });
    expect(got).toEqual(['C:\\Users\\nico\\m.onnx']);
    expect(read).toBe(0);
  });

  it('pasa solo los bytes del modelo aunque el Buffer comparta memoria con otros', async () => {
    const pool = Buffer.from([9, 9, 5, 6, 7, 9]);
    const { ort, got } = fakeOrt();
    await createOnnxSession(ort, 'D:\\Música\\m.onnx', async () => pool.subarray(2, 5));
    expect([...(got[0] as Uint8Array)]).toEqual([5, 6, 7]);
  });

  it('el VAD y la palabra de activación abren sus modelos con este cargador', () => {
    for (const f of ['../src/voice/vad-silero.ts', '../src/voice/wakeword-oww.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src).toContain('await createOnnxSession(ort, modelPath)');
      expect(src).not.toContain('InferenceSession.create(modelPath)');
    }
  });
});
